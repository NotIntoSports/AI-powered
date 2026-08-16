package localpg

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/ai-interviewer/ai-powered/control-api/internal/knowledge"
	"github.com/ledongthuc/pdf"
)

func extractText(filename, contentType string, payload []byte) (string, error) {
	ext := strings.ToLower(path.Ext(filename))
	switch {
	case ext == ".doc" || contentType == "application/msword":
		return "", fmt.Errorf("%w: .doc is not supported", knowledge.ErrSkipped)
	case ext == ".pdf" || contentType == "application/pdf":
		text, err := extractPDF(payload)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(text) == "" {
			return "", knowledge.ErrNoText
		}
		return text, nil
	case ext == ".docx" || strings.Contains(contentType, "wordprocessingml"):
		text, err := extractDOCX(payload)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(text) == "" {
			return "", knowledge.ErrNoText
		}
		return text, nil
	default:
		return "", fmt.Errorf("%w: unsupported type", knowledge.ErrSkipped)
	}
}

func extractPDF(payload []byte) (string, error) {
	reader, err := pdf.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return "", knowledge.ErrNoText
	}
	var builder strings.Builder
	for page := 1; page <= reader.NumPage(); page++ {
		plain, err := reader.Page(page).GetPlainText(nil)
		if err != nil {
			continue
		}
		builder.WriteString(plain)
		builder.WriteByte('\n')
	}
	return builder.String(), nil
}

func extractDOCX(payload []byte) (string, error) {
	archive, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return "", knowledge.ErrNoText
	}
	var document io.ReadCloser
	for _, file := range archive.File {
		if file.Name == "word/document.xml" {
			document, err = file.Open()
			if err != nil {
				return "", knowledge.ErrNoText
			}
			break
		}
	}
	if document == nil {
		return "", knowledge.ErrNoText
	}
	defer document.Close()
	decoder := xml.NewDecoder(document)
	var builder strings.Builder
	inText := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", knowledge.ErrNoText
		}
		switch item := token.(type) {
		case xml.StartElement:
			switch item.Name.Local {
			case "t":
				inText = true
			case "tab":
				builder.WriteByte(' ')
			case "br":
				builder.WriteByte('\n')
			}
		case xml.EndElement:
			switch item.Name.Local {
			case "t":
				inText = false
			case "p":
				builder.WriteByte('\n')
			}
		case xml.CharData:
			if inText {
				builder.Write(item)
			}
		}
	}
	text := builder.String()
	if utf8.RuneCountInString(text) == 0 {
		return "", knowledge.ErrNoText
	}
	return text, nil
}
