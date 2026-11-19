package main

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// rpc_test.go — unit tests for the JSON-RPC Dispatcher.
// No network: Dispatch is called directly with raw frames.

type testResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
}

func dispatch(t *testing.T, d *Dispatcher, req string) testResponse {
	t.Helper()
	raw := d.Dispatch([]byte(req))
	require.NotNil(t, raw, "expected a response frame for %s", req)
	var resp testResponse
	require.NoError(t, json.Unmarshal(raw, &resp))
	return resp
}

func TestEchoString(t *testing.T) {
	resp := dispatch(t, buildDispatcher(),
		`{"jsonrpc":"2.0","method":"echo","params":"hello","id":1}`)
	assert.Equal(t, "2.0", resp.JSONRPC)
	assert.Nil(t, resp.Error)
	assert.JSONEq(t, `"hello"`, string(resp.Result))
	assert.JSONEq(t, `1`, string(resp.ID), "echo must preserve the request id")
}

func TestEchoObject(t *testing.T) {
	resp := dispatch(t, buildDispatcher(),
		`{"jsonrpc":"2.0","method":"echo","params":{"message":"hello"},"id":2}`)
	assert.Nil(t, resp.Error)
	assert.JSONEq(t, `{"message":"hello"}`, string(resp.Result))
}

func TestPing(t *testing.T) {
	resp := dispatch(t, buildDispatcher(),
		`{"jsonrpc":"2.0","method":"ping","id":3}`)
	assert.Nil(t, resp.Error)
	assert.JSONEq(t, `"pong"`, string(resp.Result))
}

func TestUnknownMethod(t *testing.T) {
	resp := dispatch(t, buildDispatcher(),
		`{"jsonrpc":"2.0","method":"nope","id":4}`)
	require.NotNil(t, resp.Error)
	assert.Equal(t, MethodNotFound, resp.Error.Code)
}

func TestNotificationGetsNoReply(t *testing.T) {
	raw := buildDispatcher().Dispatch(
		[]byte(`{"jsonrpc":"2.0","method":"echo","params":"hello"}`))
	assert.Nil(t, raw, "notifications must not be answered")
}

func TestBatch(t *testing.T) {
	raw := buildDispatcher().Dispatch([]byte(`[
		{"jsonrpc":"2.0","method":"echo","params":"a","id":1},
		{"jsonrpc":"2.0","method":"ping","id":2}
	]`))
	require.NotNil(t, raw)
	var resps []testResponse
	require.NoError(t, json.Unmarshal(raw, &resps))
	require.Len(t, resps, 2)
	assert.JSONEq(t, `"a"`, string(resps[0].Result))
	assert.JSONEq(t, `"pong"`, string(resps[1].Result))
}

func TestParseError(t *testing.T) {
	resp := dispatch(t, buildDispatcher(), `this is not json`)
	require.NotNil(t, resp.Error)
	assert.Equal(t, ParseError, resp.Error.Code)
}
