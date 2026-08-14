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
	protectedPaths := []struct{ name, yaml string }{
		{name: "login", yaml: sectionBetween(t, spec, "  /api/v1/auth/login:", "  /api/v1/auth/logout:")},
		{name: "logout", yaml: sectionBetween(t, spec, "  /api/v1/auth/logout:", "  /api/v1/auth/me:")},
		{name: "me", yaml: sectionBetween(t, spec, "  /api/v1/auth/me:", "  /api/v1/admin/users:")},
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

func TestAuthenticationSecuritySchemesAreExact(t *testing.T) {
	spec := readSpec(t)
	security := sectionBetween(t, spec, "  securitySchemes:", "  responses:")
	for _, required := range []string{
		"    cookieAuth:\n      type: apiKey\n      in: cookie\n      name: control_session",
		"    bearerAuth:\n      type: http\n      scheme: bearer\n      bearerFormat: opaque",
	} {
		if !strings.Contains(security, required) {
			t.Fatalf("missing exact security scheme:\n%s", required)
		}
	}
}

func TestAdminUserErrorsAreDocumented(t *testing.T) {
	spec := readSpec(t)
	for _, code := range []string{"USERNAME_TAKEN", "LAST_ADMIN_REQUIRED", "USER_NOT_FOUND", "INVALID_INPUT", "UNAUTHENTICATED", "FORBIDDEN"} {
		if !strings.Contains(spec, "code: "+code) && !strings.Contains(spec, "example: {code: "+code) {
			t.Fatalf("missing documented error code %s", code)
		}
	}
	if !strings.Contains(spec, "requestId:") {
		t.Fatal("admin errors must include requestId")
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
