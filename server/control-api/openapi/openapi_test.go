package openapi

import (
	"os"
	"strings"
	"testing"
)

func TestAPIErrorRequiresRequestID(t *testing.T) {
	spec := readSpec(t)
	apiError := sectionBetween(t, spec, "    APIError:", "    User:")

	if !strings.Contains(apiError, "required: [code, message, requestId]") {
		t.Fatal("APIError must require code, message, and requestId")
	}
	if !strings.Contains(apiError, "        requestId:\n          type: string") {
		t.Fatal("APIError must declare requestId as a string property")
	}
}

func TestAuthenticationResponsesDeclareNoStore(t *testing.T) {
	spec := readSpec(t)
	protectedPaths := []struct {
		name string
		yaml string
	}{
		{name: "authentication", yaml: sectionBetween(t, spec, "  /api/v1/auth/{operation}:", "  /api/v1/admin/users:")},
		{name: "admin users", yaml: sectionBetween(t, spec, "  /api/v1/admin/users:", "  /api/v1/admin/users/{userID}:")},
		{name: "admin user", yaml: sectionBetween(t, spec, "  /api/v1/admin/users/{userID}:", "components:")},
	}

	for _, path := range protectedPaths {
		t.Run(path.name, func(t *testing.T) {
			if !strings.Contains(path.yaml, "          Cache-Control:") {
				t.Fatal("authenticated responses must declare the Cache-Control header")
			}
			if !strings.Contains(path.yaml, "              const: no-store") {
				t.Fatal("authenticated Cache-Control header must be no-store")
			}
		})
	}
}

func readSpec(t *testing.T) string {
	t.Helper()

	contents, err := os.ReadFile("openapi.yaml")
	if err != nil {
		t.Fatalf("read openapi.yaml: %v", err)
	}
	return strings.ReplaceAll(string(contents), "\r\n", "\n")
}

func sectionBetween(t *testing.T, contents, start, end string) string {
	t.Helper()

	startIndex := strings.Index(contents, start)
	if startIndex == -1 {
		t.Fatalf("start marker %q not found", start)
	}
	endIndex := strings.Index(contents[startIndex+len(start):], end)
	if endIndex == -1 {
		t.Fatalf("end marker %q not found after %q", end, start)
	}
	return contents[startIndex : startIndex+len(start)+endIndex]
}
