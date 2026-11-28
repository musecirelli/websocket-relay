// assistant.go — the Remote Server side of the Assistant
// function: it collects page snapshots and streamed console
// entries arriving on assistant/<user>/... topics.
//
// A snapshot arrives as a message sequence on
// assistant/<user>/snapshot: begin (page metadata), dom chunks
// (seq/total), console (the deduplicated buffer), end. A
// request the user refuses in the panel arrives as a single
// {kind: "denied"} message instead. The
// collector reassembles each snapshot and writes it as one JSON
// document to the -assistant-file path (latest wins), so a
// reader on this side — Muse — can answer questions about the
// page. Streamed console entries on assistant/<user>/console
// are appended as JSON lines to the -assistant-log path.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// assistantMsg is one message of a snapshot sequence.
type assistantMsg struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"` // begin | dom | console | end
	Seq     int             `json:"seq,omitempty"`
	Total   int             `json:"total,omitempty"`
	Meta    json.RawMessage `json:"meta,omitempty"`    // kind=begin
	Text    string          `json:"text,omitempty"`    // kind=dom
	Entries json.RawMessage `json:"entries,omitempty"` // kind=console
}

// assembly is one in-flight snapshot being reassembled.
type assembly struct {
	meta    json.RawMessage
	parts   map[int]string
	total   int
	entries json.RawMessage
	began   bool
	gotCons bool
	ended   bool
	created time.Time
}

func (a *assembly) complete() bool {
	return a.began && a.ended && a.gotCons && a.total > 0 && len(a.parts) == a.total
}

// snapshotInfo describes one completed snapshot — or, with
// Denied set, a request the user refused in the panel.
type snapshotInfo struct {
	ID     string
	URL    string
	Bytes  int
	Denied bool
}

type assistantCollector struct {
	mu           sync.Mutex
	pending      map[string]*assembly
	snapshotPath string
	consolePath  string
}

func newAssistantCollector(snapshotPath, consolePath string) *assistantCollector {
	return &assistantCollector{
		pending:      map[string]*assembly{},
		snapshotPath: snapshotPath,
		consolePath:  consolePath,
	}
}

// userFromTopic extracts <user> from assistant/<user>/<...>.
func userFromTopic(topic string) string {
	parts := strings.Split(topic, "/")
	if len(parts) >= 2 {
		return parts[1]
	}
	return ""
}

// handleSnapshot feeds one snapshot message. When the snapshot
// completes it writes the file and returns its info; until then
// it returns (nil, nil).
func (c *assistantCollector) handleSnapshot(payload []byte) (*snapshotInfo, error) {
	var msg assistantMsg
	if err := json.Unmarshal(payload, &msg); err != nil {
		return nil, err
	}
	if msg.ID == "" {
		return nil, fmt.Errorf("snapshot message without id")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, a := range c.pending {
		if time.Since(a.created) > time.Minute {
			delete(c.pending, id) // abandoned sequence
		}
	}
	a := c.pending[msg.ID]
	if a == nil {
		a = &assembly{parts: map[int]string{}, created: time.Now()}
		c.pending[msg.ID] = a
	}
	switch msg.Kind {
	case "denied":
		// The user refused this request in the panel: drop any
		// partial assembly and report the refusal, so it is not
		// mistaken for a lost message.
		delete(c.pending, msg.ID)
		return &snapshotInfo{ID: msg.ID, Denied: true}, nil
	case "begin":
		a.meta, a.began = msg.Meta, true
	case "dom":
		a.parts[msg.Seq], a.total = msg.Text, msg.Total
	case "console":
		a.entries, a.gotCons = msg.Entries, true
	case "end":
		a.ended = true
	default:
		return nil, fmt.Errorf("unknown snapshot kind %q", msg.Kind)
	}
	if !a.complete() {
		return nil, nil
	}
	delete(c.pending, msg.ID)

	dom := ""
	for i := 0; i < a.total; i++ {
		dom += a.parts[i]
	}
	out := struct {
		ID         string          `json:"id"`
		ReceivedAt string          `json:"receivedAt"`
		Meta       json.RawMessage `json:"meta"`
		DOM        string          `json:"dom"`
		Console    json.RawMessage `json:"console"`
	}{msg.ID, time.Now().Format(time.RFC3339), a.meta, dom, a.entries}
	data, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	tmp := c.snapshotPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, c.snapshotPath); err != nil {
		return nil, err
	}
	var meta struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal(a.meta, &meta)
	return &snapshotInfo{ID: msg.ID, URL: meta.URL, Bytes: len(data)}, nil
}

// handleConsole appends one streamed console entry (bare JSON)
// to the console log and returns a one-line summary for the
// operator log.
func (c *assistantCollector) handleConsole(payload []byte) (string, error) {
	var e struct {
		Level string `json:"level"`
		Text  string `json:"text"`
	}
	if err := json.Unmarshal(payload, &e); err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	f, err := os.OpenFile(c.consolePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.Write(append(payload, '\n')); err != nil {
		return "", err
	}
	text := e.Text
	if len(text) > 120 {
		text = text[:120] + "…"
	}
	return fmt.Sprintf("[%s] %s", e.Level, text), nil
}
