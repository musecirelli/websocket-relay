package jsonrpc

import (
	"encoding/json"
	"fmt"
	"sort"
)

// JSON-RPC 2.0 error codes (spec §5.1)
const (
	ParseError     = -32700
	InvalidRequest = -32600
	MethodNotFound = -32601
	InvalidParams  = -32602
	InternalError  = -32603
)

// Handler is the Strategy for one RPC method.
// It receives the raw `params` (may be nil) and returns a raw result,
// preserving the caller's JSON verbatim — which is what makes `echo` exact.
type Handler func(params json.RawMessage) (json.RawMessage, error)

// RPCError is an error that maps directly onto a JSON-RPC error object.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("rpc %d: %s", e.Code, e.Message) }

// Dispatcher is the method registry. Dispatch is O(1) in the number of
// methods (hash lookup) and O(n) in message size (JSON parse).
type Dispatcher struct {
	methods map[string]Handler
}

func NewDispatcher() *Dispatcher {
	return &Dispatcher{methods: make(map[string]Handler)}
}

func (d *Dispatcher) Register(name string, h Handler) {
	d.methods[name] = h
}

func (d *Dispatcher) Methods() []string {
	names := make([]string, 0, len(d.methods))
	for name := range d.methods {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	// hasID distinguishes a notification (no "id" member) from id:null.
	hasID bool
}

func (r *rpcRequest) UnmarshalJSON(data []byte) error {
	type alias rpcRequest
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*r = rpcRequest(a)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err == nil {
		_, r.hasID = raw["id"]
	}
	return nil
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
	ID      json.RawMessage `json:"id"`
}

// Dispatch parses one text frame and returns the response frame,
// or nil when the request is a notification (spec: no reply).
func (d *Dispatcher) Dispatch(raw []byte) []byte {
	// Batch request: a JSON array of requests.
	var batch []json.RawMessage
	if err := json.Unmarshal(raw, &batch); err == nil && len(raw) > 0 && raw[0] == '[' {
		var responses []json.RawMessage
		for _, item := range batch {
			if resp := d.dispatchOne(item); resp != nil {
				responses = append(responses, resp)
			}
		}
		if len(responses) == 0 {
			return nil
		}
		out, _ := json.Marshal(responses)
		// responses are already marshalled objects; re-marshal as raw array
		var rawResponses []json.RawMessage
		for _, r := range responses {
			rawResponses = append(rawResponses, r)
		}
		out, _ = json.Marshal(rawResponses)
		return out
	}
	return d.dispatchOne(raw)
}

func (d *Dispatcher) dispatchOne(raw []byte) []byte {
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return marshalResponse(rpcResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: ParseError, Message: "Parse error: " + err.Error()},
			ID:      json.RawMessage("null"),
		})
	}

	if req.JSONRPC != "2.0" || req.Method == "" {
		if !req.hasID {
			return nil
		}
		return marshalResponse(rpcResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: InvalidRequest, Message: "Invalid Request"},
			ID:      orNull(req.ID),
		})
	}

	handler, ok := d.methods[req.Method]
	if !ok {
		if !req.hasID {
			return nil
		}
		return marshalResponse(rpcResponse{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: MethodNotFound, Message: "Method not found: " + req.Method},
			ID:      orNull(req.ID),
		})
	}

	result, err := handler(req.Params)
	if err != nil {
		if !req.hasID {
			return nil
		}
		rpcErr, ok := err.(*RPCError)
		if !ok {
			rpcErr = &RPCError{Code: InternalError, Message: "Internal error: " + err.Error()}
		}
		return marshalResponse(rpcResponse{JSONRPC: "2.0", Error: rpcErr, ID: orNull(req.ID)})
	}

	if !req.hasID {
		return nil // notification
	}
	if result == nil {
		result = json.RawMessage("null")
	}
	return marshalResponse(rpcResponse{JSONRPC: "2.0", Result: result, ID: orNull(req.ID)})
}

func marshalResponse(resp rpcResponse) []byte {
	out, _ := json.Marshal(resp)
	return out
}

func orNull(id json.RawMessage) json.RawMessage {
	if id == nil {
		return json.RawMessage("null")
	}
	return id
}

// --- Step 1 methods -------------------------------------------------------

// echo returns params verbatim.
//
//	params="hello"              -> "hello"
//	params={"message":"hello"} -> {"message":"hello"}
func echoHandler(params json.RawMessage) (json.RawMessage, error) {
	if params == nil {
		return json.RawMessage("null"), nil
	}
	return params, nil
}

func pingHandler(params json.RawMessage) (json.RawMessage, error) {
	return json.RawMessage(`"pong"`), nil
}

func BuildDispatcher() *Dispatcher {
	d := NewDispatcher()
	d.Register("echo", echoHandler)
	d.Register("ping", pingHandler)
	return d
}
