package mcpadmin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/identity"
	"github.com/ai-interviewer/ai-powered/control-api/internal/presence"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const testAdminPassword = "Sup3r-Secret-Pass"

var mcpSchemaPattern = regexp.MustCompile(`^control_api_mcp_test_[a-f0-9]{32}$`)

func openMCPTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set; skipping PostgreSQL MCP integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open test PostgreSQL pool: %v", err)
	}
	if err := adminPool.Ping(ctx); err != nil {
		adminPool.Close()
		t.Fatalf("ping test PostgreSQL pool: %v", err)
	}
	t.Cleanup(adminPool.Close)

	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := "control_api_mcp_test_" + hex.EncodeToString(random)
	if !mcpSchemaPattern.MatchString(schema) {
		t.Fatalf("unsafe schema name %q", schema)
	}
	quotedSchema := fmt.Sprintf(`"%s"`, schema)
	if _, err := adminPool.Exec(ctx, "create schema "+quotedSchema); err != nil {
		t.Fatalf("create test schema: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if _, err := adminPool.Exec(cleanupCtx, "drop schema "+quotedSchema+" cascade"); err != nil {
			t.Errorf("drop test schema: %v", err)
		}
	})

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse test PostgreSQL config: %v", err)
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = make(map[string]string)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	config.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open schema-scoped pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := database.Migrate(context.Background(), pool); err != nil {
		t.Fatalf("migrate test schema: %v", err)
	}
	return pool
}

func newTestServer(t *testing.T, pool *pgxpool.Pool, actorUsername string) *Server {
	t.Helper()
	return NewServer(Dependencies{
		Identity:      identity.NewService(pool),
		Presence:      presence.NewStore(pool),
		Users:         users.NewStore(pool),
		ActorUsername: actorUsername,
	})
}

func connectInMemory(t *testing.T, server *Server) *mcp.ClientSession {
	t.Helper()
	serverTransport, clientTransport := mcp.NewInMemoryTransports()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	serverSession, err := server.MCPServer().Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("connect server session: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })

	client := mcp.NewClient(&mcp.Implementation{Name: "mcpadmin-test", Version: "0.0.0"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("connect client session: %v", err)
	}
	t.Cleanup(func() { _ = clientSession.Close() })
	return clientSession
}

func callTool(t *testing.T, session *mcp.ClientSession, name string, arguments any) *mcp.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		t.Fatalf("call tool %q: %v", name, err)
	}
	if result.IsError {
		t.Fatalf("call tool %q returned tool error: %+v", name, result.Content)
	}
	return result
}

func callToolExpectError(t *testing.T, session *mcp.ClientSession, name string, arguments any) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		return err.Error()
	}
	if !result.IsError {
		t.Fatalf("call tool %q succeeded, expected tool error", name)
	}
	var parts []string
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			parts = append(parts, text.Text)
		}
	}
	return strings.Join(parts, " ")
}

func structuredList(t *testing.T, result *mcp.CallToolResult, toolName string) []any {
	t.Helper()
	list, ok := result.StructuredContent.([]any)
	if !ok {
		t.Fatalf("tool %q structured content is %T, want []any", toolName, result.StructuredContent)
	}
	return list
}

func TestToolsListed(t *testing.T) {
	pool := openMCPTestPool(t)
	session := connectInMemory(t, newTestServer(t, pool, "root-admin"))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}

	names := make(map[string]*mcp.Tool, len(listed.Tools))
	for _, tool := range listed.Tools {
		names[tool.Name] = tool
	}
	for _, expected := range ToolNames {
		if _, ok := names[expected]; !ok {
			t.Errorf("tool %q is not registered", expected)
		}
	}
	if len(names) != len(ToolNames) {
		t.Errorf("registered %d tools, want %d", len(names), len(ToolNames))
	}
	for _, readOnly := range []string{"list_users", "list_sessions", "list_devices"} {
		tool, ok := names[readOnly]
		if !ok {
			continue
		}
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Errorf("tool %q should advertise readOnlyHint", readOnly)
		}
	}
	for _, destructive := range []string{"set_user_status", "reset_user_password", "revoke_user_sessions"} {
		tool, ok := names[destructive]
		if !ok {
			continue
		}
		if tool.Annotations == nil || tool.Annotations.DestructiveHint == nil || !*tool.Annotations.DestructiveHint {
			t.Errorf("tool %q should advertise destructiveHint", destructive)
		}
	}
}

func TestUserAndSessionLifecycle(t *testing.T) {
	pool := openMCPTestPool(t)
	server := newTestServer(t, pool, "root-admin")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := identity.NewService(pool).CreateInitialAdmin(ctx, "root-admin", testAdminPassword); err != nil {
		t.Fatalf("create initial administrator: %v", err)
	}

	session := connectInMemory(t, server)

	listed := structuredList(t, callTool(t, session, "list_users", nil), "list_users")
	if len(listed) != 1 {
		t.Fatalf("list_users returned %d users, want 1", len(listed))
	}
	admin := listed[0].(map[string]any)
	if admin["username"] != "root-admin" || admin["role"] != "admin" || admin["status"] != "active" {
		t.Fatalf("unexpected administrator view: %v", admin)
	}

	created := callTool(t, session, "create_user", map[string]any{
		"username": "operator-one",
		"password": testAdminPassword,
		"role":     "operator",
	})
	createdView, ok := created.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("create_user structured content is %T, want map", created.StructuredContent)
	}
	operatorID, _ := createdView["id"].(string)
	if operatorID == "" {
		t.Fatalf("create_user did not return a user id: %v", createdView)
	}
	if createdView["role"] != "operator" || createdView["status"] != "active" {
		t.Fatalf("unexpected created user view: %v", createdView)
	}

	statusResult := callTool(t, session, "set_user_status", map[string]any{
		"userId": operatorID,
		"status": "disabled",
	})
	if view := statusResult.StructuredContent.(map[string]any); view["status"] != "disabled" {
		t.Fatalf("set_user_status view: %v", view)
	}

	listed = structuredList(t, callTool(t, session, "list_users", nil), "list_users")
	for _, raw := range listed {
		view := raw.(map[string]any)
		if view["id"] == operatorID && view["status"] != "disabled" {
			t.Fatalf("operator status after disable: %v", view["status"])
		}
	}

	passwordResult := callTool(t, session, "reset_user_password", map[string]any{
		"userId":      operatorID,
		"newPassword": "An0ther-Secret-Pass",
	})
	passwordView := passwordResult.StructuredContent.(map[string]any)
	if passwordView["status"] != "password_reset" {
		t.Fatalf("reset_user_password view: %v", passwordView)
	}
	if strings.Contains(fmt.Sprintf("%v", passwordResult.StructuredContent), "An0ther-Secret-Pass") {
		t.Fatal("reset_user_password result must not echo the new password")
	}

	revokeResult := callTool(t, session, "revoke_user_sessions", map[string]any{
		"userId": operatorID,
	})
	if view := revokeResult.StructuredContent.(map[string]any); view["status"] != "sessions_revoked" {
		t.Fatalf("revoke_user_sessions view: %v", view)
	}

	sessions := structuredList(t, callTool(t, session, "list_sessions", nil), "list_sessions")
	if len(sessions) != 0 {
		t.Fatalf("list_sessions returned %d sessions, want 0", len(sessions))
	}
	devices := structuredList(t, callTool(t, session, "list_devices", nil), "list_devices")
	if len(devices) != 0 {
		t.Fatalf("list_devices returned %d devices, want 0", len(devices))
	}
}

func TestActorMustBeActiveAdministrator(t *testing.T) {
	pool := openMCPTestPool(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	service := identity.NewService(pool)
	if _, err := service.CreateInitialAdmin(ctx, "root-admin", testAdminPassword); err != nil {
		t.Fatalf("create initial administrator: %v", err)
	}
	root, err := users.NewStore(pool).GetByNormalizedUsername(ctx, "root-admin")
	if err != nil {
		t.Fatalf("load administrator: %v", err)
	}
	if _, err := service.CreateOperator(ctx, root.User, "operator-one", testAdminPassword); err != nil {
		t.Fatalf("create operator: %v", err)
	}

	session := connectInMemory(t, newTestServer(t, pool, "operator-one"))
	message := callToolExpectError(t, session, "list_users", nil)
	if !strings.Contains(message, "not an active administrator") {
		t.Fatalf("unexpected error message: %q", message)
	}
}

func TestDuplicateUsernameToolError(t *testing.T) {
	pool := openMCPTestPool(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := identity.NewService(pool).CreateInitialAdmin(ctx, "root-admin", testAdminPassword); err != nil {
		t.Fatalf("create initial administrator: %v", err)
	}

	session := connectInMemory(t, newTestServer(t, pool, "root-admin"))
	callTool(t, session, "create_user", map[string]any{
		"username": "operator-one",
		"password": testAdminPassword,
		"role":     "operator",
	})
	message := callToolExpectError(t, session, "create_user", map[string]any{
		"username": "operator-one",
		"password": testAdminPassword,
		"role":     "operator",
	})
	if !strings.Contains(message, "already taken") {
		t.Fatalf("unexpected error message: %q", message)
	}
}

type bearerRoundTripper struct {
	token string
}

func (b bearerRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	cloned := request.Clone(request.Context())
	cloned.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(cloned)
}

func TestStreamableHTTPHandlerAuthentication(t *testing.T) {
	pool := openMCPTestPool(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := identity.NewService(pool).CreateInitialAdmin(ctx, "root-admin", testAdminPassword); err != nil {
		t.Fatalf("create initial administrator: %v", err)
	}

	server := newTestServer(t, pool, "root-admin")
	httpServer := httptest.NewServer(server.Handler("mcp-token-123"))
	t.Cleanup(httpServer.Close)

	health, err := http.Get(httpServer.URL + "/healthz")
	if err != nil {
		t.Fatalf("request healthz: %v", err)
	}
	health.Body.Close()
	if health.StatusCode != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", health.StatusCode)
	}

	unauthorized, err := http.Post(httpServer.URL+"/mcp", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("request /mcp without token: %v", err)
	}
	unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated /mcp status = %d, want 401", unauthorized.StatusCode)
	}

	authorizedSession := connectStreamable(t, httpServer.URL+"/mcp", "mcp-token-123")
	listed := structuredList(t, callTool(t, authorizedSession, "list_users", nil), "list_users")
	if len(listed) != 1 {
		t.Fatalf("list_users over HTTP returned %d users, want 1", len(listed))
	}

	client := mcp.NewClient(&mcp.Implementation{Name: "mcpadmin-test", Version: "0.0.0"}, nil)
	wrongCtx, wrongCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer wrongCancel()
	_, err = client.Connect(wrongCtx, &mcp.StreamableClientTransport{
		Endpoint:   httpServer.URL + "/mcp",
		HTTPClient: &http.Client{Transport: bearerRoundTripper{token: "wrong-token"}},
	}, nil)
	if err == nil {
		t.Fatal("connect with wrong token succeeded, want authentication failure")
	}
}

func connectStreamable(t *testing.T, endpoint, token string) *mcp.ClientSession {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "mcpadmin-test", Version: "0.0.0"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   endpoint,
		HTTPClient: &http.Client{Transport: bearerRoundTripper{token: token}},
	}, nil)
	if err != nil {
		t.Fatalf("connect streamable session: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}
