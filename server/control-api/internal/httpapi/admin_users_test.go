package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ai-interviewer/ai-powered/control-api/internal/identity"
	"github.com/ai-interviewer/ai-powered/control-api/internal/password"
	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

func TestAdminUsersRequireBrowserAdministrator(t *testing.T) {
	adminUsers := &fakeUserAdmin{}
	tests := []struct {
		name           string
		authentication Authentication
		wantStatus     int
		wantCode       string
	}{
		{
			name:           "unauthenticated",
			authentication: &fakeAuthentication{},
			wantStatus:     http.StatusUnauthorized,
			wantCode:       "UNAUTHENTICATED",
		},
		{
			name: "operator",
			authentication: &fakeAuthentication{
				authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
					return AuthenticatedSession{
						User: users.User{ID: "operator-1", Username: "operator", Role: users.RoleOperator, Status: users.StatusActive},
						Session: sessions.Session{
							ID:      "session-operator",
							UserID:  "operator-1",
							Purpose: sessions.PurposeBrowser,
						},
						RawToken: rawToken,
					}, nil
				},
			},
			wantStatus: http.StatusForbidden,
			wantCode:   "FORBIDDEN",
		},
		{
			name: "desktop admin",
			authentication: &fakeAuthentication{
				authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
					if purpose != sessions.PurposeDesktop {
						return AuthenticatedSession{}, ErrUnauthenticated
					}
					return AuthenticatedSession{
						User:     testUser,
						Session:  sessions.Session{ID: "session-desktop", UserID: testUser.ID, Purpose: sessions.PurposeDesktop},
						RawToken: rawToken,
					}, nil
				},
			},
			wantStatus: http.StatusUnauthorized,
			wantCode:   "UNAUTHENTICATED",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := testAdminRouter(test.authentication, adminUsers)
			var response *httptest.ResponseRecorder
			if test.name == "desktop admin" {
				response = performRequest(t, router, http.MethodGet, "/api/v1/admin/users", "", map[string]string{
					"Authorization": "Bearer desktop-token",
				})
			} else if test.name == "unauthenticated" {
				response = performRequest(t, router, http.MethodGet, "/api/v1/admin/users", "", nil)
			} else {
				response = performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/admin/users", "")
			}
			assertAPIError(t, response, test.wantStatus, test.wantCode)
			assertNoStore(t, response)
			if adminUsers.listCalls != 0 || adminUsers.createCalls != 0 {
				t.Fatalf("admin service called list=%d create=%d", adminUsers.listCalls, adminUsers.createCalls)
			}
		})
	}
}

func TestAdminUsersListAndCreate(t *testing.T) {
	created := testUser
	adminUsers := &fakeUserAdmin{
		list: func(actor users.User) ([]users.User, error) {
			if actor.ID != testUser.ID {
				t.Fatalf("list actor=%s", actor.ID)
			}
			return []users.User{testUser}, nil
		},
		create: func(actor users.User, username, plainPassword string, role users.Role) (users.User, error) {
			if actor.ID != testUser.ID || username != "client.user" || plainPassword != "correct horse battery staple" || role != users.RoleOperator {
				t.Fatalf("create username=%q role=%q", username, role)
			}
			created.ID = "user-created"
			created.Username = username
			created.Role = role
			return created, nil
		},
	}
	router := testAdminRouter(adminBrowserAuth(), adminUsers)

	list := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/admin/users", "")
	if list.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	var listed []publicUser
	decodeJSON(t, list, &listed)
	if len(listed) != 1 || listed[0].ID != testUser.ID || listed[0].Username != testUser.Username {
		t.Fatalf("listed=%#v", listed)
	}
	assertNoStore(t, list)

	create := performAdminCookieRequest(t, router, http.MethodPost, "/api/v1/admin/users", `{"username":"client.user","password":"correct horse battery staple","role":"operator"}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	var body map[string]any
	decodeJSON(t, create, &body)
	if body["id"] != "user-created" || body["username"] != "client.user" || body["role"] != "operator" {
		t.Fatalf("created=%v", body)
	}
	if _, exists := body["password"]; exists {
		t.Fatal("create response exposed password")
	}
	if _, exists := body["passwordHash"]; exists {
		t.Fatal("create response exposed password hash")
	}
	assertNoStore(t, create)
}

func TestAdminUsersCreateRejectsDuplicatesInvalidRoleAndEmptyPassword(t *testing.T) {
	adminUsers := &fakeUserAdmin{
		create: func(_ users.User, username, plainPassword string, role users.Role) (users.User, error) {
			if plainPassword == "" {
				return users.User{}, password.ErrInvalidPassword
			}
			if username == "taken" {
				return users.User{}, users.ErrUsernameTaken
			}
			if role != users.RoleAdmin && role != users.RoleOperator {
				return users.User{}, users.ErrInvalidRole
			}
			return testUser, nil
		},
	}
	router := testAdminRouter(adminBrowserAuth(), adminUsers)

	duplicate := performAdminCookieRequest(t, router, http.MethodPost, "/api/v1/admin/users", `{"username":"taken","password":"correct horse battery staple","role":"operator"}`)
	assertAPIError(t, duplicate, http.StatusConflict, "USERNAME_TAKEN")

	invalidRole := performAdminCookieRequest(t, router, http.MethodPost, "/api/v1/admin/users", `{"username":"newbie","password":"correct horse battery staple","role":"superadmin"}`)
	assertAPIError(t, invalidRole, http.StatusUnprocessableEntity, "INVALID_INPUT")

	emptyPassword := performAdminCookieRequest(t, router, http.MethodPost, "/api/v1/admin/users", `{"username":"newbie","password":"","role":"operator"}`)
	assertAPIError(t, emptyPassword, http.StatusUnprocessableEntity, "INVALID_INPUT")
}

func TestAdminUsersPatchDisableAndResetRevokeThroughService(t *testing.T) {
	adminUsers := &fakeUserAdmin{
		setStatus: func(actor users.User, userID string, status users.Status) error {
			if actor.ID != testUser.ID || userID != "user-2" || status != users.StatusDisabled {
				t.Fatalf("setStatus user=%s status=%s", userID, status)
			}
			return nil
		},
		resetPassword: func(actor users.User, userID, newPassword string) error {
			if actor.ID != testUser.ID || userID != "user-2" || newPassword != "correct horse battery staple" {
				t.Fatalf("reset user=%s", userID)
			}
			return nil
		},
		revokeSessions: func(actor users.User, userID, preserveSessionID string) error {
			if actor.ID != testUser.ID || userID != testUser.ID || preserveSessionID != "session-admin" {
				t.Fatalf("revoke user=%s preserve=%s", userID, preserveSessionID)
			}
			return nil
		},
	}
	router := testAdminRouter(adminBrowserAuth(), adminUsers)

	disabled := performAdminCookieRequest(t, router, http.MethodPatch, "/api/v1/admin/users/user-2", `{"status":"disabled"}`)
	if disabled.Code != http.StatusNoContent {
		t.Fatalf("disable status=%d body=%s", disabled.Code, disabled.Body.String())
	}
	assertNoStore(t, disabled)

	invalidStatus := performAdminCookieRequest(t, router, http.MethodPatch, "/api/v1/admin/users/user-2", `{"status":"deleted"}`)
	assertAPIError(t, invalidStatus, http.StatusUnprocessableEntity, "INVALID_INPUT")

	lastAdmin := &fakeUserAdmin{
		setStatus: func(users.User, string, users.Status) error { return users.ErrLastAdmin },
	}
	lastAdminResponse := performAdminCookieRequest(t, testAdminRouter(adminBrowserAuth(), lastAdmin), http.MethodPatch, "/api/v1/admin/users/"+testUser.ID, `{"status":"disabled"}`)
	assertAPIError(t, lastAdminResponse, http.StatusConflict, "LAST_ADMIN_REQUIRED")

	missing := &fakeUserAdmin{
		setStatus: func(users.User, string, users.Status) error { return users.ErrUserNotFound },
	}
	missingResponse := performAdminCookieRequest(t, testAdminRouter(adminBrowserAuth(), missing), http.MethodPatch, "/api/v1/admin/users/missing", `{"status":"disabled"}`)
	assertAPIError(t, missingResponse, http.StatusNotFound, "USER_NOT_FOUND")

	reset := performAdminCookieRequest(t, router, http.MethodPost, "/api/v1/admin/users/user-2/reset-password", `{"password":"correct horse battery staple"}`)
	if reset.Code != http.StatusNoContent {
		t.Fatalf("reset status=%d body=%s", reset.Code, reset.Body.String())
	}

	revoke := performAdminCookieRequest(t, router, http.MethodPost, "/api/v1/admin/users/"+testUser.ID+"/revoke-sessions", `{"preserveCurrent":true}`)
	if revoke.Code != http.StatusNoContent {
		t.Fatalf("revoke status=%d body=%s", revoke.Code, revoke.Body.String())
	}
	if adminUsers.lastPreserveSessionID != "session-admin" {
		t.Fatalf("preserveSessionID=%q", adminUsers.lastPreserveSessionID)
	}

	revokeOther := &fakeUserAdmin{
		revokeSessions: func(_ users.User, userID, preserveSessionID string) error {
			if userID != "user-2" || preserveSessionID != "" {
				t.Fatalf("other revoke user=%s preserve=%s", userID, preserveSessionID)
			}
			return nil
		},
	}
	other := performAdminCookieRequest(t, testAdminRouter(adminBrowserAuth(), revokeOther), http.MethodPost, "/api/v1/admin/users/user-2/revoke-sessions", `{"preserveCurrent":true}`)
	if other.Code != http.StatusNoContent {
		t.Fatalf("other revoke status=%d body=%s", other.Code, other.Body.String())
	}
}

func TestAdminUsersCreateMapsIdentityErrors(t *testing.T) {
	router := testAdminRouter(adminBrowserAuth(), &fakeUserAdmin{
		create: func(users.User, string, string, users.Role) (users.User, error) {
			return users.User{}, password.ErrInvalidPassword
		},
	})
	response := performAdminCookieRequest(t, router, http.MethodPost, "/api/v1/admin/users", `{"username":"newbie","password":"short","role":"operator"}`)
	assertAPIError(t, response, http.StatusUnprocessableEntity, "INVALID_INPUT")
}

type fakeUserAdmin struct {
	list                  func(actor users.User) ([]users.User, error)
	create                func(actor users.User, username, password string, role users.Role) (users.User, error)
	setStatus             func(actor users.User, userID string, status users.Status) error
	resetPassword         func(actor users.User, userID, newPassword string) error
	revokeSessions        func(actor users.User, userID, preserveSessionID string) error
	listCalls             int
	createCalls           int
	lastPreserveSessionID string
}

func (fake *fakeUserAdmin) ListUsers(_ context.Context, actor users.User) ([]users.User, error) {
	fake.listCalls++
	if fake.list == nil {
		return nil, identity.ErrService
	}
	return fake.list(actor)
}

func (fake *fakeUserAdmin) CreateUser(_ context.Context, actor users.User, username, plainPassword string, role users.Role) (users.User, error) {
	fake.createCalls++
	if fake.create == nil {
		return users.User{}, identity.ErrService
	}
	return fake.create(actor, username, plainPassword, role)
}

func (fake *fakeUserAdmin) SetUserStatus(_ context.Context, actor users.User, userID string, status users.Status) error {
	if fake.setStatus == nil {
		return identity.ErrService
	}
	return fake.setStatus(actor, userID, status)
}

func (fake *fakeUserAdmin) ResetPassword(_ context.Context, actor users.User, userID, newPassword string) error {
	if fake.resetPassword == nil {
		return identity.ErrService
	}
	return fake.resetPassword(actor, userID, newPassword)
}

func (fake *fakeUserAdmin) RevokeUserSessions(_ context.Context, actor users.User, userID, preserveSessionID string) error {
	fake.lastPreserveSessionID = preserveSessionID
	if fake.revokeSessions == nil {
		return identity.ErrService
	}
	return fake.revokeSessions(actor, userID, preserveSessionID)
}

func adminBrowserAuth() Authentication {
	return &fakeAuthentication{
		authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
			if purpose != sessions.PurposeBrowser || rawToken != "browser-token" {
				return AuthenticatedSession{}, ErrUnauthenticated
			}
			return AuthenticatedSession{
				User:     testUser,
				Session:  sessions.Session{ID: "session-admin", UserID: testUser.ID, Purpose: sessions.PurposeBrowser},
				RawToken: rawToken,
			}, nil
		},
	}
}

func testAdminRouter(authentication Authentication, adminUsers UserAdmin) http.Handler {
	return NewRouter(Dependencies{
		Authentication: authentication,
		UserAdmin:      adminUsers,
		SessionTTL:     testSessionTTL,
		CookieSecure:   true,
	})
}

func performAdminCookieRequest(t *testing.T, handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "browser-token"})
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestAdminUsersJSONRoundTripDoesNotIncludePassword(t *testing.T) {
	encoded, err := json.Marshal(toPublicUser(testUser))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(encoded)), "password") {
		t.Fatalf("public user JSON contains password material: %s", encoded)
	}
}

var _ UserAdmin = (*fakeUserAdmin)(nil)

func TestAdminUsersUnknownServiceErrorIsInternal(t *testing.T) {
	router := testAdminRouter(adminBrowserAuth(), &fakeUserAdmin{
		list: func(users.User) ([]users.User, error) { return nil, errors.New("sql: connection reset") },
	})
	response := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/admin/users", "")
	assertAPIError(t, response, http.StatusInternalServerError, "INTERNAL_ERROR")
	if strings.Contains(strings.ToLower(response.Body.String()), "sql") {
		t.Fatalf("internal error leaked: %s", response.Body.String())
	}
}
