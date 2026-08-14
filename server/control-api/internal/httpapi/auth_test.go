package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/password"
	"github.com/ai-interviewer/ai-powered/control-api/internal/ratelimit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const testSessionTTL = 2 * time.Hour

var testUser = users.User{
	ID:        "user-1",
	Username:  "Admin",
	Role:      users.RoleAdmin,
	Status:    users.StatusActive,
	CreatedAt: time.Date(2026, 8, 15, 1, 2, 3, 0, time.UTC),
	UpdatedAt: time.Date(2026, 8, 15, 2, 3, 4, 0, time.UTC),
}

func TestLoginRejectsMalformedUnknownTrailingAndOversizedJSON(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantCode   string
	}{
		{name: "malformed", body: `{"username":`, wantStatus: http.StatusBadRequest, wantCode: "INVALID_INPUT"},
		{name: "unknown field", body: `{"username":"admin","password":"correct horse battery staple","purpose":"browser","extra":true}`, wantStatus: http.StatusBadRequest, wantCode: "INVALID_INPUT"},
		{name: "two values", body: `{"username":"admin","password":"correct horse battery staple","purpose":"browser"} {}`, wantStatus: http.StatusBadRequest, wantCode: "INVALID_INPUT"},
		{name: "over 32 KiB", body: `{"username":"admin","password":"` + strings.Repeat("x", 33*1024) + `","purpose":"browser"}`, wantStatus: http.StatusRequestEntityTooLarge, wantCode: "REQUEST_TOO_LARGE"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			authentication := &fakeAuthentication{}
			response := performRequest(t, testRouter(authentication, nil), http.MethodPost, "/api/v1/auth/login", test.body, nil)

			assertAPIError(t, response, test.wantStatus, test.wantCode)
			assertNoStore(t, response)
			if authentication.loginCalls != 0 {
				t.Fatalf("login calls=%d, want 0", authentication.loginCalls)
			}
		})
	}
}

func TestLoginReturnsIdenticalErrorForWrongCredentialsAndDisabledUser(t *testing.T) {
	authentication := &fakeAuthentication{
		login: func(attempt LoginAttempt) (LoginResult, error) {
			return LoginResult{}, ErrInvalidCredentials
		},
	}
	router := testRouter(authentication, nil)
	headers := map[string]string{"X-Request-Id": "request-same"}

	wrong := performRequest(t, router, http.MethodPost, "/api/v1/auth/login", `{"username":"admin","password":"wrong password value","purpose":"browser"}`, headers)
	disabled := performRequest(t, router, http.MethodPost, "/api/v1/auth/login", `{"username":"disabled","password":"correct horse battery staple","purpose":"browser"}`, headers)

	assertAPIError(t, wrong, http.StatusUnauthorized, "INVALID_CREDENTIALS")
	assertAPIError(t, disabled, http.StatusUnauthorized, "INVALID_CREDENTIALS")
	if wrong.Body.String() != disabled.Body.String() {
		t.Fatalf("credential errors differ:\nwrong=%s\ndisabled=%s", wrong.Body.String(), disabled.Body.String())
	}
	assertNoStore(t, wrong)
	assertNoStore(t, disabled)
}

func TestLoginBrowserSetsStrictSecureCookieAndOmitsAccessToken(t *testing.T) {
	expiresAt := time.Now().UTC().Add(testSessionTTL)
	authentication := &fakeAuthentication{
		login: func(attempt LoginAttempt) (LoginResult, error) {
			if attempt.Purpose != sessions.PurposeBrowser || attempt.Username != "admin" || attempt.Password == "" {
				t.Fatalf("unexpected login attempt: %#v", attempt)
			}
			return LoginResult{User: testUser, AccessToken: "browser-secret", ExpiresAt: expiresAt}, nil
		},
	}

	response := performRequest(t, testRouter(authentication, nil), http.MethodPost, "/api/v1/auth/login", `{"username":"admin","password":"correct horse battery staple","purpose":"browser"}`, nil)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies=%d, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != sessionCookieName || cookie.Value != "browser-secret" || cookie.Path != "/" || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie flags=%#v", cookie)
	}
	if cookie.MaxAge != int(testSessionTTL/time.Second) {
		t.Fatalf("cookie MaxAge=%d", cookie.MaxAge)
	}
	var body map[string]any
	decodeJSON(t, response, &body)
	if _, exists := body["accessToken"]; exists {
		t.Fatal("browser response exposed accessToken")
	}
	if body["expiresAt"] != expiresAt.Format(time.RFC3339Nano) {
		t.Fatalf("expiresAt=%v", body["expiresAt"])
	}
	assertNoStore(t, response)
}

func TestLoginDesktopReturnsBearerTokenWithoutCookie(t *testing.T) {
	expiresAt := time.Now().UTC().Add(testSessionTTL)
	authentication := &fakeAuthentication{
		login: func(attempt LoginAttempt) (LoginResult, error) {
			if attempt.Purpose != sessions.PurposeDesktop || attempt.DeviceID != "device-1" {
				t.Fatalf("unexpected login attempt: %#v", attempt)
			}
			return LoginResult{User: testUser, AccessToken: "desktop-secret", ExpiresAt: expiresAt}, nil
		},
	}

	response := performRequest(t, testRouter(authentication, nil), http.MethodPost, "/api/v1/auth/login", `{"username":"admin","password":"correct horse battery staple","purpose":"desktop","deviceId":"device-1"}`, nil)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(response.Result().Cookies()) != 0 {
		t.Fatal("desktop response set a cookie")
	}
	var body map[string]any
	decodeJSON(t, response, &body)
	if body["accessToken"] != "desktop-secret" {
		t.Fatalf("accessToken=%v", body["accessToken"])
	}
	assertNoStore(t, response)
}

func TestMeRejectsCredentialPurposeMismatch(t *testing.T) {
	authentication := &fakeAuthentication{
		authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
			if rawToken == "browser-token" && purpose == sessions.PurposeDesktop {
				return AuthenticatedSession{}, ErrUnauthenticated
			}
			return AuthenticatedSession{}, errors.New("unexpected credential")
		},
	}

	response := performRequest(t, testRouter(authentication, nil), http.MethodGet, "/api/v1/auth/me", "", map[string]string{"Authorization": "Bearer browser-token"})

	assertAPIError(t, response, http.StatusUnauthorized, "UNAUTHENTICATED")
	assertNoStore(t, response)
}

func TestLogoutRevokesCurrentSessionAndExpiresBrowserCookie(t *testing.T) {
	authentication := &fakeAuthentication{
		authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
			return AuthenticatedSession{
				User:     testUser,
				Session:  sessions.Session{ID: "session-1", UserID: testUser.ID, Purpose: sessions.PurposeBrowser},
				RawToken: rawToken,
			}, nil
		},
	}
	router := testRouter(authentication, nil)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "browser-token"})
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if authentication.logoutCalls != 1 || authentication.lastLogout.RawToken != "browser-token" || authentication.lastLogout.UserID != testUser.ID {
		t.Fatalf("logout=%#v calls=%d", authentication.lastLogout, authentication.logoutCalls)
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != sessionCookieName || cookies[0].MaxAge >= 0 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("expired cookie=%#v", cookies)
	}
	assertNoStore(t, response)
}

func TestMeReturnsOnlyPublicUserFieldsForDesktopBearer(t *testing.T) {
	authentication := &fakeAuthentication{
		authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
			if rawToken != "desktop-token" || purpose != sessions.PurposeDesktop {
				t.Fatalf("authenticate token=%q purpose=%q", rawToken, purpose)
			}
			return AuthenticatedSession{
				User:     testUser,
				Session:  sessions.Session{ID: "session-1", UserID: testUser.ID, Purpose: sessions.PurposeDesktop},
				RawToken: rawToken,
			}, nil
		},
	}

	response := performRequest(t, testRouter(authentication, nil), http.MethodGet, "/api/v1/auth/me", "", map[string]string{"Authorization": "Bearer desktop-token"})

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body map[string]any
	decodeJSON(t, response, &body)
	if body["id"] != testUser.ID || body["username"] != testUser.Username || body["role"] != string(testUser.Role) || body["status"] != string(testUser.Status) {
		t.Fatalf("body=%#v", body)
	}
	for _, forbidden := range []string{"password", "passwordHash", "accessToken"} {
		if _, exists := body[forbidden]; exists {
			t.Fatalf("public user response contains %q", forbidden)
		}
	}
	assertNoStore(t, response)
}

func TestLoginRateLimitUsesNormalizedUsernameAndCanonicalSource(t *testing.T) {
	authentication := &fakeAuthentication{
		login: func(LoginAttempt) (LoginResult, error) { return LoginResult{}, ErrInvalidCredentials },
	}
	router := testRouter(authentication, nil)

	for attempt := 0; attempt < 10; attempt++ {
		username := "admin"
		if attempt%2 == 1 {
			username = " ADMIN "
		}
		body := `{"username":"` + username + `","password":"wrong password value","purpose":"browser"}`
		response := performRequest(t, router, http.MethodPost, "/api/v1/auth/login", body, nil)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status=%d", attempt+1, response.Code)
		}
	}
	response := performRequest(t, router, http.MethodPost, "/api/v1/auth/login", `{"username":"admin","password":"wrong password value","purpose":"browser"}`, nil)
	assertAPIError(t, response, http.StatusTooManyRequests, "RATE_LIMITED")
	if authentication.loginCalls != 10 {
		t.Fatalf("login calls=%d, want 10", authentication.loginCalls)
	}
}

func TestLoginTrustsForwardedAddressOnlyFromConfiguredProxy(t *testing.T) {
	prefix := netip.MustParsePrefix("10.0.0.0/8")
	authentication := &fakeAuthentication{
		login: func(LoginAttempt) (LoginResult, error) { return LoginResult{}, ErrInvalidCredentials },
	}
	router := testRouter(authentication, []netip.Prefix{prefix})

	trustedRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"username":"admin","password":"wrong password value","purpose":"browser"}`))
	trustedRequest.RemoteAddr = "10.0.0.5:4321"
	trustedRequest.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.4")
	trustedResponse := httptest.NewRecorder()
	router.ServeHTTP(trustedResponse, trustedRequest)
	if authentication.lastLogin.SourceIP != "203.0.113.9" {
		t.Fatalf("trusted proxy source=%q", authentication.lastLogin.SourceIP)
	}

	untrustedRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"username":"other","password":"wrong password value","purpose":"browser"}`))
	untrustedRequest.RemoteAddr = "198.51.100.7:4321"
	untrustedRequest.Header.Set("X-Forwarded-For", "203.0.113.10")
	untrustedResponse := httptest.NewRecorder()
	router.ServeHTTP(untrustedResponse, untrustedRequest)
	if authentication.lastLogin.SourceIP != "198.51.100.7" {
		t.Fatalf("untrusted peer source=%q", authentication.lastLogin.SourceIP)
	}
}

func TestRequireSessionEnforcesPurpose(t *testing.T) {
	nextCalled := false
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { nextCalled = true })
	handler := RequireSession(sessions.PurposeBrowser, next)
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request = request.WithContext(context.WithValue(request.Context(), authenticatedSessionKey{}, AuthenticatedSession{
		User:    testUser,
		Session: sessions.Session{Purpose: sessions.PurposeDesktop},
	}))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	assertAPIError(t, response, http.StatusUnauthorized, "UNAUTHENTICATED")
	if nextCalled {
		t.Fatal("purpose mismatch reached protected handler")
	}
}

func TestLoginUnknownUserPerformsDummyVerificationAndCommitsMinimalFailureAudit(t *testing.T) {
	db := &loginAuthDB{}
	verifyCalls := 0
	authentication := newDatabaseAuthenticationWithVerifier(
		db,
		testSessionTTL,
		"dummy-encoded-hash",
		func(encoded, plain string) (bool, bool, error) {
			verifyCalls++
			if db.begins != 0 {
				t.Fatal("password verification ran inside a transaction")
			}
			if encoded != "dummy-encoded-hash" || plain != "wrong password value" {
				t.Fatalf("dummy verification encoded=%q plain=%q", encoded, plain)
			}
			return false, false, nil
		},
	)

	_, err := authentication.Login(context.Background(), LoginAttempt{
		Username:  " Missing.User ",
		Password:  "wrong password value",
		Purpose:   sessions.PurposeBrowser,
		RequestID: "request-login-failed",
		SourceIP:  "192.0.2.30",
	})

	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("error=%v", err)
	}
	if verifyCalls != 1 {
		t.Fatalf("verify calls=%d, want 1", verifyCalls)
	}
	if db.begins != 1 || db.commits != 1 || db.rollbacks != 0 {
		t.Fatalf("begins=%d commits=%d rollbacks=%d", db.begins, db.commits, db.rollbacks)
	}
	if db.sawSessionSQL {
		t.Fatal("unknown user created a session")
	}
	if db.auditRequestID != "request-login-failed" || db.auditSourceIP != "192.0.2.30" {
		t.Fatalf("audit request=%q source=%q", db.auditRequestID, db.auditSourceIP)
	}
	if db.auditMetadata != `{"username":"missing.user"}` {
		t.Fatalf("audit metadata=%s", db.auditMetadata)
	}
	if strings.Contains(strings.ToLower(db.auditMetadata), "password") {
		t.Fatal("failure audit contains password material")
	}
}

func TestLoginDisabledUserVerifiesStoredHashAndReturnsInvalidCredentials(t *testing.T) {
	db := &loginAuthDB{lookup: &users.UserWithPassword{
		User:         users.User{ID: "user-disabled", Username: "disabled", Role: users.RoleOperator, Status: users.StatusDisabled},
		PasswordHash: "stored-encoded-hash",
	}}
	verifyCalls := 0
	authentication := newDatabaseAuthenticationWithVerifier(
		db,
		testSessionTTL,
		"dummy-encoded-hash",
		func(encoded, plain string) (bool, bool, error) {
			verifyCalls++
			if db.begins != 0 {
				t.Fatal("password verification ran inside a transaction")
			}
			if encoded != "stored-encoded-hash" || encoded == "dummy-encoded-hash" {
				t.Fatalf("disabled user verification encoded=%q", encoded)
			}
			if plain != "correct horse battery staple" {
				t.Fatalf("unexpected password material in verify")
			}
			return true, false, nil
		},
	)

	_, err := authentication.Login(context.Background(), LoginAttempt{
		Username:  "disabled",
		Password:  "correct horse battery staple",
		Purpose:   sessions.PurposeBrowser,
		RequestID: "request-disabled",
		SourceIP:  "192.0.2.31",
	})

	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("error=%v", err)
	}
	if verifyCalls != 1 {
		t.Fatalf("verify calls=%d, want 1", verifyCalls)
	}
	if db.begins != 1 || db.commits != 1 || db.rollbacks != 0 {
		t.Fatalf("begins=%d commits=%d rollbacks=%d", db.begins, db.commits, db.rollbacks)
	}
	if db.sawSessionSQL {
		t.Fatal("disabled user created a session")
	}
	if db.auditMetadata != `{"username":"disabled"}` {
		t.Fatalf("audit metadata=%s", db.auditMetadata)
	}
}

func TestLoginWrongPasswordVerifiesStoredHashAndReturnsInvalidCredentials(t *testing.T) {
	db := &loginAuthDB{lookup: &users.UserWithPassword{
		User:         users.User{ID: "user-1", Username: "admin", Role: users.RoleAdmin, Status: users.StatusActive},
		PasswordHash: "stored-encoded-hash",
	}}
	verifyCalls := 0
	authentication := newDatabaseAuthenticationWithVerifier(
		db,
		testSessionTTL,
		"dummy-encoded-hash",
		func(encoded, _ string) (bool, bool, error) {
			verifyCalls++
			if db.begins != 0 {
				t.Fatal("password verification ran inside a transaction")
			}
			if encoded != "stored-encoded-hash" {
				t.Fatalf("wrong-password verification encoded=%q", encoded)
			}
			return false, false, nil
		},
	)

	_, err := authentication.Login(context.Background(), LoginAttempt{
		Username:  "admin",
		Password:  "wrong password value",
		Purpose:   sessions.PurposeBrowser,
		RequestID: "request-wrong-password",
		SourceIP:  "192.0.2.33",
	})

	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("error=%v", err)
	}
	if verifyCalls != 1 {
		t.Fatalf("verify calls=%d, want 1", verifyCalls)
	}
	if db.begins != 1 || db.commits != 1 || db.sawSessionSQL {
		t.Fatalf("begins=%d commits=%d session=%v", db.begins, db.commits, db.sawSessionSQL)
	}
}

func TestLoginRejectsUserDisabledBetweenLookupAndCommit(t *testing.T) {
	disabled := users.StatusDisabled
	db := &loginAuthDB{
		lookup: &users.UserWithPassword{
			User:         users.User{ID: "user-1", Username: "admin", Role: users.RoleAdmin, Status: users.StatusActive},
			PasswordHash: "stored-encoded-hash",
		},
		recheckStatus: &disabled,
	}
	verifyCalls := 0
	authentication := newDatabaseAuthenticationWithVerifier(
		db,
		testSessionTTL,
		"dummy-encoded-hash",
		func(encoded, plain string) (bool, bool, error) {
			verifyCalls++
			if db.begins != 0 {
				t.Fatal("password verification ran inside a transaction")
			}
			if encoded != "stored-encoded-hash" {
				t.Fatalf("verification encoded=%q", encoded)
			}
			return true, false, nil
		},
	)

	_, err := authentication.Login(context.Background(), LoginAttempt{
		Username:  "admin",
		Password:  "correct horse battery staple",
		Purpose:   sessions.PurposeBrowser,
		RequestID: "request-disabled-after-lookup",
		SourceIP:  "192.0.2.32",
	})

	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("error=%v", err)
	}
	if verifyCalls != 1 {
		t.Fatalf("verify calls=%d, want 1", verifyCalls)
	}
	if db.begins != 1 || db.commits != 1 || db.rollbacks != 0 {
		t.Fatalf("begins=%d commits=%d rollbacks=%d", db.begins, db.commits, db.rollbacks)
	}
	if db.sawSessionSQL {
		t.Fatal("disabled-after-lookup user created a session")
	}
	if db.auditMetadata != `{"username":"admin"}` {
		t.Fatalf("audit metadata=%s", db.auditMetadata)
	}
}

func TestDatabaseAuthenticationPostgresLoginAndLogoutAreAtomic(t *testing.T) {
	pool := openHTTPAPITestPool(t)
	ctx := context.Background()
	encodedPassword, err := password.Hash("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	created, err := users.NewStore(pool).Create(ctx, users.CreateInput{
		Username:     "admin",
		PasswordHash: encodedPassword,
		Role:         users.RoleAdmin,
	})
	if err != nil {
		t.Fatal(err)
	}
	authentication, err := NewDatabaseAuthentication(pool, testSessionTTL)
	if err != nil {
		t.Fatal(err)
	}

	login, err := authentication.Login(ctx, LoginAttempt{
		Username:  "admin",
		Password:  "correct horse battery staple",
		Purpose:   sessions.PurposeBrowser,
		RequestID: "request-login-success",
		SourceIP:  "192.0.2.40",
	})
	if err != nil {
		t.Fatal(err)
	}
	if login.AccessToken == "" || login.User.ID != created.ID || login.User.LastLoginAt == nil {
		t.Fatalf("login=%#v", login)
	}
	var sessionCount, loginAuditCount int
	var lastLoginAt *time.Time
	if err := pool.QueryRow(ctx, `select count(*) from user_sessions where user_id = $1 and revoked_at is null`, created.ID).Scan(&sessionCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select last_login_at from users where id = $1`, created.ID).Scan(&lastLoginAt); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from audit_logs where action = 'auth.login_succeeded' and request_id = $1`, "request-login-success").Scan(&loginAuditCount); err != nil {
		t.Fatal(err)
	}
	if sessionCount != 1 || lastLoginAt == nil || loginAuditCount != 1 {
		t.Fatalf("sessions=%d lastLogin=%v audit=%d", sessionCount, lastLoginAt, loginAuditCount)
	}

	authenticated, err := authentication.Authenticate(ctx, login.AccessToken, sessions.PurposeBrowser)
	if err != nil {
		t.Fatal(err)
	}
	if err := authentication.Logout(ctx, LogoutAttempt{
		UserID:    authenticated.User.ID,
		SessionID: authenticated.Session.ID,
		RawToken:  login.AccessToken,
		RequestID: "request-logout",
		SourceIP:  "192.0.2.40",
	}); err != nil {
		t.Fatal(err)
	}
	var revokedCount, logoutAuditCount int
	if err := pool.QueryRow(ctx, `select count(*) from user_sessions where id = $1 and revoked_at is not null`, authenticated.Session.ID).Scan(&revokedCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from audit_logs where action = 'auth.logout' and request_id = $1`, "request-logout").Scan(&logoutAuditCount); err != nil {
		t.Fatal(err)
	}
	if revokedCount != 1 || logoutAuditCount != 1 {
		t.Fatalf("revoked=%d audit=%d", revokedCount, logoutAuditCount)
	}
}

type loginAuthDB struct {
	lookup         *users.UserWithPassword
	recheckStatus  *users.Status
	begins         int
	commits        int
	rollbacks      int
	auditRequestID string
	auditSourceIP  string
	auditMetadata  string
	sawSessionSQL  bool
}

func (db *loginAuthDB) Begin(context.Context) (pgx.Tx, error) {
	db.begins++
	return &loginAuthTx{parent: db}, nil
}

func (*loginAuthDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("query executed outside transaction")
}

func (*loginAuthDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("query executed outside transaction")
}

func (db *loginAuthDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if !strings.Contains(sql, "username_normalized") {
		return authTestRow{err: errors.New("query executed outside transaction")}
	}
	if db.lookup == nil {
		return authTestRow{err: pgx.ErrNoRows}
	}
	user := *db.lookup
	return authScanRow{values: []any{
		user.ID, user.Username, user.Role, user.Status,
		user.CreatedAt, user.UpdatedAt, user.LastLoginAt, user.PasswordHash,
	}}
}

type loginAuthTx struct {
	parent *loginAuthDB
	closed bool
}

func (*loginAuthTx) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("unexpected nested transaction")
}

func (tx *loginAuthTx) Commit(context.Context) error {
	if tx.closed {
		return pgx.ErrTxClosed
	}
	tx.closed = true
	tx.parent.commits++
	return nil
}

func (tx *loginAuthTx) Rollback(context.Context) error {
	if tx.closed {
		return pgx.ErrTxClosed
	}
	tx.closed = true
	tx.parent.rollbacks++
	return nil
}

func (*loginAuthTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errors.New("unexpected CopyFrom")
}

func (*loginAuthTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (*loginAuthTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }

func (*loginAuthTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, errors.New("unexpected Prepare")
}

func (tx *loginAuthTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if !strings.Contains(sql, "insert into audit_logs") {
		return pgconn.CommandTag{}, errors.New("unexpected Exec")
	}
	tx.parent.auditRequestID = args[6].(string)
	tx.parent.auditSourceIP = args[7].(string)
	tx.parent.auditMetadata = args[8].(string)
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (*loginAuthTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query")
}

func (tx *loginAuthTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if strings.Contains(sql, "insert into user_sessions") || strings.Contains(sql, "select exists") {
		tx.parent.sawSessionSQL = true
		return authTestRow{err: errors.New("unexpected session query")}
	}
	if strings.Contains(sql, "from users") && strings.Contains(sql, "where id = $1") {
		if tx.parent.lookup == nil {
			return authTestRow{err: pgx.ErrNoRows}
		}
		user := tx.parent.lookup.User
		if tx.parent.recheckStatus != nil {
			user.Status = *tx.parent.recheckStatus
		}
		return authScanRow{values: []any{
			user.ID, user.Username, user.Role, user.Status,
			user.CreatedAt, user.UpdatedAt, user.LastLoginAt,
		}}
	}
	return authTestRow{err: pgx.ErrNoRows}
}

func (*loginAuthTx) Conn() *pgx.Conn { return nil }

type authTestRow struct{ err error }

func (row authTestRow) Scan(...any) error { return row.err }

type authScanRow struct {
	values []any
	err    error
}

func (row authScanRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(dest) != len(row.values) {
		return fmt.Errorf("scan dest=%d values=%d", len(dest), len(row.values))
	}
	for index, value := range row.values {
		switch target := dest[index].(type) {
		case *string:
			*target = value.(string)
		case *users.Role:
			*target = value.(users.Role)
		case *users.Status:
			*target = value.(users.Status)
		case *time.Time:
			*target = value.(time.Time)
		case **time.Time:
			if value == nil {
				*target = nil
			} else {
				*target = value.(*time.Time)
			}
		default:
			return fmt.Errorf("unexpected scan destination type %T", dest[index])
		}
	}
	return nil
}

var httpAPISchemaPattern = regexp.MustCompile(`^control_api_http_test_[a-f0-9]{32}$`)

func openHTTPAPITestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set; skipping PostgreSQL authentication integration test")
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
	schema := "control_api_http_test_" + hex.EncodeToString(random)
	if !httpAPISchemaPattern.MatchString(schema) {
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

type fakeAuthentication struct {
	login        func(LoginAttempt) (LoginResult, error)
	authenticate func(rawToken, purpose string) (AuthenticatedSession, error)
	logout       func(LogoutAttempt) error
	loginCalls   int
	logoutCalls  int
	lastLogin    LoginAttempt
	lastLogout   LogoutAttempt
}

func (fake *fakeAuthentication) Login(_ context.Context, attempt LoginAttempt) (LoginResult, error) {
	fake.loginCalls++
	fake.lastLogin = attempt
	if fake.login == nil {
		return LoginResult{}, ErrAuthenticationService
	}
	return fake.login(attempt)
}

func (fake *fakeAuthentication) Authenticate(_ context.Context, rawToken, purpose string) (AuthenticatedSession, error) {
	if fake.authenticate == nil {
		return AuthenticatedSession{}, ErrUnauthenticated
	}
	return fake.authenticate(rawToken, purpose)
}

func (fake *fakeAuthentication) Logout(_ context.Context, attempt LogoutAttempt) error {
	fake.logoutCalls++
	fake.lastLogout = attempt
	if fake.logout == nil {
		return nil
	}
	return fake.logout(attempt)
}

func testRouter(authentication Authentication, trustedProxyCIDRs []netip.Prefix) http.Handler {
	return NewRouter(Dependencies{
		Authentication:    authentication,
		LoginLimiter:      ratelimit.NewLoginLimiter(),
		SessionTTL:        testSessionTTL,
		CookieSecure:      true,
		TrustedProxyCIDRs: trustedProxyCIDRs,
	})
}

func performRequest(t *testing.T, handler http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertAPIError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status=%d want=%d body=%s", response.Code, status, response.Body.String())
	}
	var apiError APIError
	decodeJSON(t, response, &apiError)
	if apiError.Code != code || apiError.Message == "" || apiError.RequestID == "" {
		t.Fatalf("API error=%#v", apiError)
	}
}

func assertNoStore(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q", response.Header().Get("Cache-Control"))
	}
}

func decodeJSON(t *testing.T, response *httptest.ResponseRecorder, destination any) {
	t.Helper()
	if err := json.NewDecoder(response.Body).Decode(destination); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, response.Body.String())
	}
}
