package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCollectorReassemblesSnapshot(t *testing.T) {
	dir := t.TempDir()
	c := newAssistantCollector(
		filepath.Join(dir, "snap.json"), filepath.Join(dir, "console.log"))

	feed := func(payload string) *snapshotInfo {
		info, err := c.handleSnapshot([]byte(payload))
		require.NoError(t, err)
		return info
	}
	// Out of order: end and a DOM chunk arrive before begin; the
	// snapshot completes only when the last DOM chunk lands.
	assert.Nil(t, feed(`{"id":"s1","kind":"end"}`))
	assert.Nil(t, feed(`{"id":"s1","kind":"dom","seq":1,"total":2,"text":"</html>"}`))
	assert.Nil(t, feed(`{"id":"s1","kind":"begin","meta":{"url":"http://example.test/","title":"T"}}`))
	assert.Nil(t, feed(`{"id":"s1","kind":"console","entries":[{"level":"error","text":"boom","count":3}]}`))
	info := feed(`{"id":"s1","kind":"dom","seq":0,"total":2,"text":"<html>"}`)
	require.NotNil(t, info)
	assert.Equal(t, "s1", info.ID)
	assert.Equal(t, "http://example.test/", info.URL)

	data, err := os.ReadFile(filepath.Join(dir, "snap.json"))
	require.NoError(t, err)
	var doc struct {
		DOM string `json:"dom"`
	}
	require.NoError(t, json.Unmarshal(data, &doc))
	assert.Equal(t, "<html></html>", doc.DOM)
	assert.Contains(t, string(data), `"text":"boom"`)
}

func TestCollectorDenied(t *testing.T) {
	dir := t.TempDir()
	c := newAssistantCollector(
		filepath.Join(dir, "snap.json"), filepath.Join(dir, "console.log"))

	info, err := c.handleSnapshot([]byte(`{"id":"s9","kind":"denied"}`))
	require.NoError(t, err)
	require.NotNil(t, info)
	assert.True(t, info.Denied)
	assert.Equal(t, "s9", info.ID)

	_, err = os.Stat(filepath.Join(dir, "snap.json"))
	assert.True(t, os.IsNotExist(err))
}

func TestCollectorConsoleAppend(t *testing.T) {
	dir := t.TempDir()
	c := newAssistantCollector(
		filepath.Join(dir, "snap.json"), filepath.Join(dir, "console.log"))

	summary, err := c.handleConsole([]byte(`{"level":"warn","text":"careful","count":1}`))
	require.NoError(t, err)
	assert.Equal(t, "[warn] careful", summary)

	data, err := os.ReadFile(filepath.Join(dir, "console.log"))
	require.NoError(t, err)
	assert.Contains(t, string(data), `"text":"careful"`)
}
