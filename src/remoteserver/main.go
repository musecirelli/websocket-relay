// Remote Server — the far end of the Comms Shim's Chat relay.
//
// A standalone Go server that localhostServer dials (TCP) when a
// Relay Tool Chat panel connects. Protocol: newline-delimited JSON
// (see server/relay.go):
//
//	{"type":"hello","from":"localhostServer"}
//	{"type":"msg","from":"chat","text":"hi"}        -> logged
//	{"type":"msg","from":"remote","text":"hello"}   <- sent back
//
// It is an operator console: everything received is printed to
// stdout, and operator lines are broadcast to all connected
// clients as chat messages from "remote". That is what makes it a
// test setup — a human (or Muse) sits on this end and talks back.
// Operator lines come from stdin, or from the file/FIFO named by
// -console (reopened on EOF, so a detached server can be fed one
// writer session at a time: `printf 'hi\n' > /path/to/fifo`).
//
// Run (from the repo root): make run-remote   (or: go run ./remoteserver from src/)
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"time"
)

// message is one NDJSON frame, mirroring remoteMessage in
// server/relay.go.
type message struct {
	Type string `json:"type"`
	From string `json:"from,omitempty"`
	Text string `json:"text,omitempty"`
}

type client struct {
	conn net.Conn
	wmu  sync.Mutex // serialize frame writes to this client
}

func (c *client) send(m message) {
	frame, err := json.Marshal(m)
	if err != nil {
		return
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.conn.Write(append(frame, '\n'))
}

var (
	mu      sync.Mutex
	clients = make(map[*client]bool)
)

func broadcast(m message) {
	mu.Lock()
	defer mu.Unlock()
	for c := range clients {
		c.send(m)
	}
}

func main() {
	port := flag.Int("port", 9000, "listen port (all interfaces)")
	console := flag.String("console", "",
		"read operator lines from this file/FIFO instead of stdin (reopened on EOF)")
	flag.Parse()

	addr := fmt.Sprintf(":%d", *port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}
	fmt.Printf("Remote Server listening on %s\n", addr)
	fmt.Println("Type a line and press Enter to send it to all connected chats. Ctrl+C stops.")

	if *console != "" {
		go operatorFile(*console)
	} else {
		go operatorStdin()
	}

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			continue
		}
		go handleConn(conn)
	}
}

// operatorStdin turns lines on stdin into chat messages from
// "remote", broadcast to every connected client.
func operatorStdin() {
	scanLines(os.Stdin)
}

// operatorFile is the detached form of the operator console: it
// reads lines from the named file or FIFO, and when the writer
// goes away (EOF) it reopens the path and waits for the next one.
// Each writer session is just: open, write lines, close.
func operatorFile(path string) {
	for {
		f, err := os.Open(path)
		if err != nil {
			log.Printf("console %s: %v (retrying)", path, err)
			time.Sleep(2 * time.Second)
			continue
		}
		scanLines(f)
		f.Close()
	}
}

func scanLines(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		text := scanner.Text()
		if text == "" {
			continue
		}
		log.Printf("[remote -> all] %s", text)
		broadcast(message{Type: "msg", From: "remote", Text: text})
	}
}

func handleConn(conn net.Conn) {
	c := &client{conn: conn}
	mu.Lock()
	clients[c] = true
	mu.Unlock()
	log.Printf("[connect] %s", conn.RemoteAddr())
	c.send(message{Type: "msg", From: "remote",
		Text: "connected to Remote Server — an operator is listening on this end. Say hi."})

	defer func() {
		mu.Lock()
		delete(clients, c)
		mu.Unlock()
		conn.Close()
		log.Printf("[disconnect] %s", conn.RemoteAddr())
	}()

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		var m message
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			log.Printf("[%s] (unparsable) %s", conn.RemoteAddr(), scanner.Text())
			continue
		}
		switch m.Type {
		case "hello":
			log.Printf("[hello] %s (%s)", conn.RemoteAddr(), m.From)
		case "msg":
			log.Printf("[chat] %s: %s", conn.RemoteAddr(), m.Text)
		default:
			log.Printf("[%s] %s", conn.RemoteAddr(), scanner.Text())
		}
	}
}
