package resumes

import (
	"bytes"
	"strings"
	"testing"
)

func TestSanitizeFilenameKeepsBasename(t *testing.T) {
	got := sanitizeFilename(`C:\Users\a\简历.pdf`)
	if got != "简历.pdf" {
		t.Fatalf("got %q", got)
	}
}

func TestDetectResumeTypePDF(t *testing.T) {
	payload := []byte("%PDF-1.7 fake")
	if detectResumeType("cv.pdf", payload, "application/pdf") != "application/pdf" {
		t.Fatal("expected pdf")
	}
}

func TestDetectResumeTypeRejectsExe(t *testing.T) {
	if detectResumeType("malware.exe", []byte("MZ"), "application/octet-stream") != "" {
		t.Fatal("exe should be rejected")
	}
}

func TestReadResumeFileRejectsEmpty(t *testing.T) {
	_, _, _, err := readResumeFile(UploadInput{Filename: "a.pdf", Body: bytes.NewReader(nil)})
	if err != ErrInvalidInput {
		t.Fatalf("err=%v", err)
	}
}

func TestReadResumeFileRejectsTooLarge(t *testing.T) {
	_, _, _, err := readResumeFile(UploadInput{
		Filename: "a.pdf",
		Body:     bytes.NewReader(append([]byte("%PDF-1.7\n"), bytes.Repeat([]byte("a"), MaxBytes)...)),
	})
	if err != ErrTooLarge {
		t.Fatalf("err=%v", err)
	}
}

func TestSanitizeFilenameRejectsTraversal(t *testing.T) {
	if sanitizeFilename("..") != "" {
		t.Fatal("expected empty")
	}
	if strings.Contains(sanitizeFilename("../x.pdf"), "..") {
		t.Fatal("traversal remained")
	}
}
