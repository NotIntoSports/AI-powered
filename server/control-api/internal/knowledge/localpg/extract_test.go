package localpg

import (
	"archive/zip"
	"bytes"
	"errors"
	"testing"

	"github.com/ai-interviewer/ai-powered/control-api/internal/knowledge"
)

func TestExtractDOCXReadsParagraphs(t *testing.T) {
	payload := minimalDOCX("负责 Node.js 订单服务")
	text, err := extractText("cv.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", payload)
	if err != nil {
		t.Fatal(err)
	}
	if text == "" || !bytes.Contains([]byte(text), []byte("Node.js")) {
		t.Fatalf("text=%q", text)
	}
}

func TestExtractDocIsSkipped(t *testing.T) {
	_, err := extractText("cv.doc", "application/msword", []byte{0xD0, 0xCF, 0x11, 0xE0})
	if !errors.Is(err, knowledge.ErrSkipped) {
		t.Fatalf("err=%v", err)
	}
}

func TestExtractPDFWithoutTextLayerFails(t *testing.T) {
	payload := []byte("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")
	_, err := extractText("scan.pdf", "application/pdf", payload)
	if !errors.Is(err, knowledge.ErrNoText) {
		t.Fatalf("err=%v", err)
	}
}

func minimalDOCX(body string) []byte {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	file, err := writer.Create("word/document.xml")
	if err != nil {
		panic(err)
	}
	_, _ = file.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>` + body + `</w:t></w:r></w:p></w:body>
</w:document>`))
	if err := writer.Close(); err != nil {
		panic(err)
	}
	return buffer.Bytes()
}
