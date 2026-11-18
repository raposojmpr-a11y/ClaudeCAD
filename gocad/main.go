//go:build js && wasm

// gocad-wasm exposes go-cad's DWG -> DXF conversion to the browser for ClaudeCAD.
// Only the drawing package is linked (no renderer, fonts or images), to keep the wasm small.
//
// After the module starts, it defines globalThis.gocadDwgToDxf(bytes: Uint8Array):
// it returns {dxf: Uint8Array} on success or {error: string} on failure.
package main

import (
	"bytes"
	"fmt"
	"syscall/js"

	"github.com/unitedrhino/go-cad/internal/drawing"
)

func convert(data []byte) (out []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("go-cad: %v", r)
		}
	}()
	doc, err := drawing.Parse(data)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := drawing.WriteDXF(doc, &buf); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func main() {
	js.Global().Set("gocadDwgToDxf", js.FuncOf(func(this js.Value, args []js.Value) any {
		result := js.Global().Get("Object").New()
		if len(args) < 1 {
			result.Set("error", "missing DWG bytes")
			return result
		}
		input := make([]byte, args[0].Get("length").Int())
		js.CopyBytesToGo(input, args[0])
		out, err := convert(input)
		if err != nil {
			result.Set("error", err.Error())
			return result
		}
		array := js.Global().Get("Uint8Array").New(len(out))
		js.CopyBytesToJS(array, out)
		result.Set("dxf", array)
		return result
	}))
	select {}
}
