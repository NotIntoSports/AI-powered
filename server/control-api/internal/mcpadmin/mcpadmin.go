// Package mcpadmin exposes user and session administration of the control API
// as Model Context Protocol tools over a Streamable HTTP endpoint.
package mcpadmin

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/identity"
	"github.com/ai-interviewer/ai-powered/control-api/internal/password"
	"github.com/ai-interviewer/ai-powered/control-api/internal/presence"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ToolNames lists every tool registered on the MCP server.
var ToolNames = []string{
	"list_users",
	"create_user",
	"set_user_status",
	"reset_user_password",
	"revoke_user_sessions",
	"list_sessions",
	"list_devices",
}

// Dependencies bundles the control API services the MCP server reuses.
type Dependencies struct {
	Identity      *identity.Service
	Presence      *presence.Store
	Users         *users.Store
	ActorUsername string
}

// Server serves the administrative identity and presence services as MCP tools.
//
// Every tool call is attributed to the configured actor user, which must be an
// active administrator; the same authorization rules as the HTTP admin routes
// apply and every mutation is recorded by the identity service's audit trail.
type Server struct {
	identity      *identity.Service
	presence      *presence.Store
	users         *users.Store
	actorUsername string
}

func NewServer(dependencies Dependencies) *Server {
	return &Server{
		identity:      dependencies.Identity,
		presence:      dependencies.Presence,
		users:         dependencies.Users,
		actorUsername: dependencies.ActorUsername,
	}
}

// MCPServer builds an mcp.Server with all administrative tools registered.
// A fresh server is built per Streamable HTTP session so sessions stay
// independent.
func (s *Server) MCPServer() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "control-api-admin",
		Version: "1.0.0",
	}, nil)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_users",
		Description: "List all control API users with role, status, and online presence.",
		Annotations: &mcp.ToolAnnotations{
			Title:        "List users",
			ReadOnlyHint: true,
		},
	}, s.listUsers)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "create_user",
		Description: "Create a user with role admin or operator. The username must be 3-64 characters of letters, digits, dot, underscore, or dash.",
		Annotations: &mcp.ToolAnnotations{
			Title:           "Create user",
			DestructiveHint: boolPointer(false),
		},
	}, s.createUser)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "set_user_status",
		Description: "Enable or disable a user. Disabling a user revokes all of their sessions.",
		Annotations: &mcp.ToolAnnotations{
			Title:           "Set user status",
			DestructiveHint: boolPointer(true),
		},
	}, s.setUserStatus)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "reset_user_password",
		Description: "Reset a user's password. All of the user's sessions are revoked immediately. The new password is never echoed back.",
		Annotations: &mcp.ToolAnnotations{
			Title:           "Reset user password",
			DestructiveHint: boolPointer(true),
		},
	}, s.resetUserPassword)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "revoke_user_sessions",
		Description: "Revoke all active sessions of a user, optionally preserving one session by ID.",
		Annotations: &mcp.ToolAnnotations{
			Title:           "Revoke user sessions",
			DestructiveHint: boolPointer(true),
		},
	}, s.revokeUserSessions)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_sessions",
		Description: "List all active, non-expired user sessions with device and last-used information.",
		Annotations: &mcp.ToolAnnotations{
			Title:        "List sessions",
			ReadOnlyHint: true,
		},
	}, s.listSessions)

	mcp.AddTool(server, &mcp.Tool{
		Name:        "list_devices",
		Description: "List all known client devices with version, operating system, and online state.",
		Annotations: &mcp.ToolAnnotations{
			Title:        "List devices",
			ReadOnlyHint: true,
		},
	}, s.listDevices)

	return server
}

// Handler returns the HTTP handler for the MCP service: the Streamable HTTP
// endpoint at /mcp guarded by a bearer token, plus an unauthenticated /healthz
// probe.
func (s *Server) Handler(adminToken string) http.Handler {
	streamable := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		return s.MCPServer()
	}, nil)

	mux := http.NewServeMux()
	mux.Handle("/mcp", requireBearerToken(adminToken)(streamable))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Service string `json:"service"`
			Status  string `json:"status"`
		}{
			Service: "control-api-mcp",
			Status:  "ok",
		})
	})
	return mux
}

// actor loads the configured actor and requires an active administrator,
// mirroring the HTTP admin routes' authorization model.
func (s *Server) actor(ctx context.Context) (users.User, error) {
	account, err := s.users.GetByNormalizedUsername(ctx, s.actorUsername)
	if err != nil {
		return users.User{}, identity.ErrForbidden
	}
	if account.Role != users.RoleAdmin || account.Status != users.StatusActive {
		return users.User{}, identity.ErrForbidden
	}
	return account.User, nil
}

type userView struct {
	ID             string     `json:"id"`
	Username       string     `json:"username"`
	Role           string     `json:"role"`
	Status         string     `json:"status"`
	Online         bool       `json:"online"`
	ActiveSessions int        `json:"activeSessions"`
	LastSeenAt     *time.Time `json:"lastSeenAt"`
	CreatedAt      time.Time  `json:"createdAt"`
}

func (s *Server) listUsers(ctx context.Context, _ *mcp.CallToolRequest, _ any) (*mcp.CallToolResult, []userView, error) {
	actor, err := s.actor(ctx)
	if err != nil {
		return nil, nil, mapToolError(err)
	}
	listed, err := s.identity.ListUsers(ctx, actor)
	if err != nil {
		return nil, nil, mapToolError(err)
	}
	presenceByUser, err := s.presence.ListUserPresence(ctx)
	if err != nil {
		return nil, nil, mapToolError(err)
	}

	views := make([]userView, 0, len(listed))
	for _, user := range listed {
		view := userView{
			ID:        user.ID,
			Username:  user.Username,
			Role:      string(user.Role),
			Status:    string(user.Status),
			CreatedAt: user.CreatedAt,
		}
		if item, ok := presenceByUser[user.ID]; ok {
			view.Online = item.Online
			view.ActiveSessions = item.ActiveSessionCount
			view.LastSeenAt = item.LastSeenAt
		}
		views = append(views, view)
	}
	return nil, views, nil
}

type createUserInput struct {
	Username string `json:"username" jsonschema:"required,Username for the new user, 3-64 characters of letters, digits, dot, underscore, or dash"`
	Password string `json:"password" jsonschema:"required,Initial password meeting the password policy"`
	Role     string `json:"role" jsonschema:"required,Role of the new user; one of admin or operator"`
}

func (s *Server) createUser(ctx context.Context, _ *mcp.CallToolRequest, input createUserInput) (*mcp.CallToolResult, userView, error) {
	actor, err := s.actor(ctx)
	if err != nil {
		return nil, userView{}, mapToolError(err)
	}
	role := users.Role(strings.ToLower(strings.TrimSpace(input.Role)))
	created, err := s.identity.CreateUser(ctx, actor, input.Username, input.Password, role)
	if err != nil {
		return nil, userView{}, mapToolError(err)
	}
	return nil, userView{
		ID:        created.ID,
		Username:  created.Username,
		Role:      string(created.Role),
		Status:    string(created.Status),
		CreatedAt: created.CreatedAt,
	}, nil
}

type setUserStatusInput struct {
	UserID string `json:"userId" jsonschema:"required,ID of the user to update"`
	Status string `json:"status" jsonschema:"required,New status; one of active or disabled"`
}

type statusView struct {
	UserID string `json:"userId"`
	Status string `json:"status"`
}

func (s *Server) setUserStatus(ctx context.Context, _ *mcp.CallToolRequest, input setUserStatusInput) (*mcp.CallToolResult, statusView, error) {
	actor, err := s.actor(ctx)
	if err != nil {
		return nil, statusView{}, mapToolError(err)
	}
	status := users.Status(strings.ToLower(strings.TrimSpace(input.Status)))
	if status != users.StatusActive && status != users.StatusDisabled {
		return nil, statusView{}, mapToolError(users.ErrInvalidStatus)
	}
	if err := s.identity.SetUserStatus(ctx, actor, input.UserID, status); err != nil {
		return nil, statusView{}, mapToolError(err)
	}
	return nil, statusView{UserID: input.UserID, Status: string(status)}, nil
}

type resetPasswordInput struct {
	UserID      string `json:"userId" jsonschema:"required,ID of the user whose password is reset"`
	NewPassword string `json:"newPassword" jsonschema:"required,New password meeting the password policy"`
}

func (s *Server) resetUserPassword(ctx context.Context, _ *mcp.CallToolRequest, input resetPasswordInput) (*mcp.CallToolResult, statusView, error) {
	actor, err := s.actor(ctx)
	if err != nil {
		return nil, statusView{}, mapToolError(err)
	}
	if err := s.identity.ResetPassword(ctx, actor, input.UserID, input.NewPassword); err != nil {
		return nil, statusView{}, mapToolError(err)
	}
	// Deliberately return only the outcome; the new password must never be
	// echoed in tool results.
	return nil, statusView{UserID: input.UserID, Status: "password_reset"}, nil
}

type revokeSessionsInput struct {
	UserID            string `json:"userId" jsonschema:"required,ID of the user whose sessions are revoked"`
	PreserveSessionID string `json:"preserveSessionId,omitempty" jsonschema:"Optional session ID to keep alive, typically the caller's own session"`
}

func (s *Server) revokeUserSessions(ctx context.Context, _ *mcp.CallToolRequest, input revokeSessionsInput) (*mcp.CallToolResult, statusView, error) {
	actor, err := s.actor(ctx)
	if err != nil {
		return nil, statusView{}, mapToolError(err)
	}
	if err := s.identity.RevokeUserSessions(ctx, actor, input.UserID, input.PreserveSessionID); err != nil {
		return nil, statusView{}, mapToolError(err)
	}
	return nil, statusView{UserID: input.UserID, Status: "sessions_revoked"}, nil
}

type sessionView struct {
	ID         string     `json:"id"`
	UserID     string     `json:"userId"`
	Username   string     `json:"username"`
	Purpose    string     `json:"purpose"`
	DeviceID   string     `json:"deviceId"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	Online     bool       `json:"online"`
}

func (s *Server) listSessions(ctx context.Context, _ *mcp.CallToolRequest, _ any) (*mcp.CallToolResult, []sessionView, error) {
	if _, err := s.actor(ctx); err != nil {
		return nil, nil, mapToolError(err)
	}
	lines, err := s.presence.ListLines(ctx)
	if err != nil {
		return nil, nil, mapToolError(err)
	}
	views := make([]sessionView, 0, len(lines))
	for _, line := range lines {
		views = append(views, sessionView{
			ID:         line.ID,
			UserID:     line.UserID,
			Username:   line.Username,
			Purpose:    line.Purpose,
			DeviceID:   line.DeviceID,
			CreatedAt:  line.CreatedAt,
			ExpiresAt:  line.ExpiresAt,
			LastUsedAt: line.LastUsedAt,
			Online:     line.Online,
		})
	}
	return nil, views, nil
}

type deviceView struct {
	ID            string    `json:"id"`
	UserID        string    `json:"userId"`
	Username      string    `json:"username"`
	ClientVersion string    `json:"clientVersion"`
	OS            string    `json:"os"`
	OSVersion     string    `json:"osVersion"`
	LastSeenAt    time.Time `json:"lastSeenAt"`
	Disabled      bool      `json:"disabled"`
	Online        bool      `json:"online"`
}

func (s *Server) listDevices(ctx context.Context, _ *mcp.CallToolRequest, _ any) (*mcp.CallToolResult, []deviceView, error) {
	if _, err := s.actor(ctx); err != nil {
		return nil, nil, mapToolError(err)
	}
	devices, err := s.presence.ListDevices(ctx)
	if err != nil {
		return nil, nil, mapToolError(err)
	}
	views := make([]deviceView, 0, len(devices))
	for _, device := range devices {
		views = append(views, deviceView{
			ID:            device.ID,
			UserID:        device.UserID,
			Username:      device.Username,
			ClientVersion: device.ClientVersion,
			OS:            device.OS,
			OSVersion:     device.OSVersion,
			LastSeenAt:    device.LastSeenAt,
			Disabled:      device.Disabled,
			Online:        device.Online,
		})
	}
	return nil, views, nil
}

// mapToolError converts service sentinel errors into readable tool errors
// without leaking internal details. Returned errors are reported by the SDK
// as tool results with isError set, so the calling model can see and react.
func mapToolError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, identity.ErrForbidden):
		return errors.New("the configured MCP actor is not an active administrator")
	case errors.Is(err, identity.ErrAdminAlreadyExists):
		return errors.New("an administrator already exists")
	case errors.Is(err, users.ErrUserNotFound):
		return errors.New("user not found")
	case errors.Is(err, users.ErrUsernameTaken):
		return errors.New("username is already taken")
	case errors.Is(err, users.ErrInvalidUsername):
		return errors.New("username must be 3-64 characters of letters, digits, dot, underscore, or dash")
	case errors.Is(err, users.ErrInvalidRole):
		return errors.New("role must be one of admin or operator")
	case errors.Is(err, users.ErrInvalidStatus):
		return errors.New("status must be one of active or disabled")
	case errors.Is(err, users.ErrLastAdmin):
		return errors.New("cannot disable or remove the last active administrator")
	case errors.Is(err, users.ErrCannotDisableSelf):
		return errors.New("cannot disable the current administrator")
	case errors.Is(err, password.ErrInvalidPassword):
		return errors.New("password does not meet the password policy")
	default:
		return errors.New("internal service error")
	}
}

func requireBearerToken(expected string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			const prefix = "Bearer "
			header := r.Header.Get("Authorization")
			authorized := false
			if len(header) > len(prefix) && strings.EqualFold(header[:len(prefix)], prefix) {
				token := header[len(prefix):]
				authorized = subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1
			}
			if !authorized {
				w.Header().Set("WWW-Authenticate", `Bearer realm="control-api-mcp"`)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func boolPointer(value bool) *bool {
	return &value
}
