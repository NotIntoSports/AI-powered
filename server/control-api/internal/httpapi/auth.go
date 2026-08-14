package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/audit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/password"
	"github.com/ai-interviewer/ai-powered/control-api/internal/ratelimit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"
)

const sessionCookieName = "control_session"

var (
	ErrInvalidCredentials    = errors.New("invalid credentials")
	ErrUnauthenticated       = errors.New("unauthenticated")
	ErrAuthenticationService = errors.New("authentication service unavailable")
)

type LoginAttempt struct {
	Username  string
	Password  string
	Purpose   string
	DeviceID  string
	RequestID string
	SourceIP  string
}

type LoginResult struct {
	User        users.User
	AccessToken string
	ExpiresAt   time.Time
}

type AuthenticatedSession struct {
	User     users.User
	Session  sessions.Session
	RawToken string
}

type LogoutAttempt struct {
	UserID    string
	SessionID string
	RawToken  string
	RequestID string
	SourceIP  string
}

type Authentication interface {
	Login(context.Context, LoginAttempt) (LoginResult, error)
	Authenticate(context.Context, string, string) (AuthenticatedSession, error)
	Logout(context.Context, LogoutAttempt) error
}

const dummyPlainPassword = "dummy password value"

type verifyPasswordFunc func(string, string) (bool, bool, error)

type databaseAuthentication struct {
	db        database.DBTX
	ttl       time.Duration
	dummyHash string
	verify    verifyPasswordFunc
}

// NewDatabaseAuthentication creates the PostgreSQL authentication service and
// prepares a process-local dummy Argon2id hash for unknown-user verification.
func NewDatabaseAuthentication(db database.DBTX, ttl time.Duration) (*databaseAuthentication, error) {
	if db == nil || ttl <= 0 {
		return nil, ErrAuthenticationService
	}
	dummyHash, err := password.Hash(dummyPlainPassword)
	if err != nil {
		return nil, ErrAuthenticationService
	}
	return newDatabaseAuthenticationWithVerifier(db, ttl, dummyHash, password.Verify), nil
}

func newDatabaseAuthenticationWithVerifier(db database.DBTX, ttl time.Duration, dummyHash string, verify verifyPasswordFunc) *databaseAuthentication {
	return &databaseAuthentication{db: db, ttl: ttl, dummyHash: dummyHash, verify: verify}
}

func (authentication *databaseAuthentication) Login(ctx context.Context, attempt LoginAttempt) (LoginResult, error) {
	normalizedUsername := strings.ToLower(strings.TrimSpace(attempt.Username))
	invalidCredentials := false
	result := LoginResult{}

	err := pgx.BeginFunc(ctx, authentication.db, func(tx pgx.Tx) error {
		storedUser, lookupError := users.NewStore(tx).GetByNormalizedUsername(ctx, normalizedUsername)
		found := lookupError == nil
		encodedPassword := authentication.dummyHash
		if found {
			encodedPassword = storedUser.PasswordHash
		}

		matches, verificationError := authentication.verifyCredential(encodedPassword, attempt.Password)
		if lookupError != nil && !errors.Is(lookupError, users.ErrUserNotFound) {
			return ErrAuthenticationService
		}
		if verificationError != nil {
			return verificationError
		}
		if !found || !matches || storedUser.Status != users.StatusActive {
			if err := appendLoginFailure(ctx, tx, attempt, normalizedUsername); err != nil {
				return err
			}
			invalidCredentials = true
			return nil
		}

		rawToken, session, err := sessions.NewStore(tx).Create(ctx, sessions.CreateInput{
			UserID:   storedUser.ID,
			Purpose:  attempt.Purpose,
			DeviceID: attempt.DeviceID,
			TTL:      authentication.ttl,
		})
		if errors.Is(err, sessions.ErrUnauthenticated) || errors.Is(err, sessions.ErrInvalidPurpose) {
			if auditError := appendLoginFailure(ctx, tx, attempt, normalizedUsername); auditError != nil {
				return auditError
			}
			invalidCredentials = true
			return nil
		}
		if err != nil {
			return ErrAuthenticationService
		}

		now := time.Now().UTC().Truncate(time.Microsecond)
		command, err := tx.Exec(ctx, `
			update users
			set last_login_at = $2, updated_at = $2
			where id = $1 and status = 'active'
		`, storedUser.ID, now)
		if err != nil || command.RowsAffected() != 1 {
			return ErrAuthenticationService
		}
		if err := audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: storedUser.ID,
			Action:      audit.ActionLoginSucceeded,
			TargetType:  "user",
			TargetID:    storedUser.ID,
			Result:      audit.ResultSuccess,
			RequestID:   nonemptyRequestID(attempt.RequestID),
			SourceIP:    attempt.SourceIP,
			Metadata:    map[string]any{"purpose": attempt.Purpose},
		}); err != nil {
			return ErrAuthenticationService
		}

		storedUser.LastLoginAt = &now
		storedUser.UpdatedAt = now
		result = LoginResult{User: storedUser.User, AccessToken: rawToken, ExpiresAt: session.ExpiresAt}
		return nil
	})
	if err != nil {
		return LoginResult{}, mapAuthenticationError(err)
	}
	if invalidCredentials {
		return LoginResult{}, ErrInvalidCredentials
	}
	return result, nil
}

func (authentication *databaseAuthentication) Authenticate(ctx context.Context, rawToken, purpose string) (AuthenticatedSession, error) {
	user, session, err := sessions.NewStore(authentication.db).Authenticate(ctx, rawToken, purpose)
	if errors.Is(err, sessions.ErrUnauthenticated) {
		return AuthenticatedSession{}, ErrUnauthenticated
	}
	if err != nil {
		return AuthenticatedSession{}, ErrAuthenticationService
	}
	return AuthenticatedSession{User: user, Session: session, RawToken: rawToken}, nil
}

func (authentication *databaseAuthentication) Logout(ctx context.Context, attempt LogoutAttempt) error {
	err := pgx.BeginFunc(ctx, authentication.db, func(tx pgx.Tx) error {
		if err := sessions.NewStore(tx).RevokeToken(ctx, attempt.RawToken); err != nil {
			if errors.Is(err, sessions.ErrUnauthenticated) {
				return ErrUnauthenticated
			}
			return ErrAuthenticationService
		}
		if err := audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: attempt.UserID,
			Action:      audit.ActionLogout,
			TargetType:  "session",
			TargetID:    attempt.SessionID,
			Result:      audit.ResultSuccess,
			RequestID:   nonemptyRequestID(attempt.RequestID),
			SourceIP:    attempt.SourceIP,
		}); err != nil {
			return ErrAuthenticationService
		}
		return nil
	})
	return mapAuthenticationError(err)
}

func (authentication *databaseAuthentication) verifyCredential(encodedPassword, plainPassword string) (bool, error) {
	match, _, err := authentication.verify(encodedPassword, plainPassword)
	if err == nil {
		return match, nil
	}
	if _, _, dummyError := authentication.verify(authentication.dummyHash, dummyPlainPassword); dummyError != nil {
		return false, ErrAuthenticationService
	}
	if errors.Is(err, password.ErrInvalidPassword) {
		return false, nil
	}
	return false, ErrAuthenticationService
}

func appendLoginFailure(ctx context.Context, tx pgx.Tx, attempt LoginAttempt, normalizedUsername string) error {
	if err := audit.NewStore(tx).Append(ctx, audit.Event{
		Action:     audit.ActionLoginFailed,
		TargetType: "auth",
		Result:     audit.ResultFailure,
		RequestID:  nonemptyRequestID(attempt.RequestID),
		SourceIP:   attempt.SourceIP,
		Metadata:   map[string]any{"username": normalizedUsername},
	}); err != nil {
		return ErrAuthenticationService
	}
	return nil
}

func nonemptyRequestID(value string) string {
	if value == "" {
		return "request-unknown"
	}
	return value
}

func mapAuthenticationError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrInvalidCredentials) {
		return ErrInvalidCredentials
	}
	if errors.Is(err, ErrUnauthenticated) {
		return ErrUnauthenticated
	}
	return ErrAuthenticationService
}

type unavailableAuthentication struct{}

func (unavailableAuthentication) Login(context.Context, LoginAttempt) (LoginResult, error) {
	return LoginResult{}, ErrAuthenticationService
}

func (unavailableAuthentication) Authenticate(context.Context, string, string) (AuthenticatedSession, error) {
	return AuthenticatedSession{}, ErrAuthenticationService
}

func (unavailableAuthentication) Logout(context.Context, LogoutAttempt) error {
	return ErrAuthenticationService
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Purpose  string `json:"purpose"`
	DeviceID string `json:"deviceId,omitempty"`
}

type publicUser struct {
	ID          string       `json:"id"`
	Username    string       `json:"username"`
	Role        users.Role   `json:"role"`
	Status      users.Status `json:"status"`
	CreatedAt   time.Time    `json:"createdAt"`
	UpdatedAt   time.Time    `json:"updatedAt"`
	LastLoginAt *time.Time   `json:"lastLoginAt,omitempty"`
}

type loginResponse struct {
	User        publicUser `json:"user"`
	AccessToken string     `json:"accessToken,omitempty"`
	ExpiresAt   time.Time  `json:"expiresAt"`
}

type authHandler struct {
	authentication    Authentication
	loginLimiter      *ratelimit.LoginLimiter
	sessionTTL        time.Duration
	cookieSecure      bool
	trustedProxyCIDRs []netip.Prefix
}

func newAuthHandler(dependencies Dependencies) *authHandler {
	authentication := dependencies.Authentication
	if authentication == nil {
		authentication = unavailableAuthentication{}
	}
	limiter := dependencies.LoginLimiter
	if limiter == nil {
		limiter = ratelimit.NewLoginLimiter()
	}
	ttl := dependencies.SessionTTL
	if ttl <= 0 {
		ttl = 8 * time.Hour
	}
	return &authHandler{
		authentication:    authentication,
		loginLimiter:      limiter,
		sessionTTL:        ttl,
		cookieSecure:      dependencies.CookieSecure,
		trustedProxyCIDRs: append([]netip.Prefix(nil), dependencies.TrustedProxyCIDRs...),
	}
}

func (handler *authHandler) login(w http.ResponseWriter, request *http.Request) {
	input := loginRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAPIError(w, request, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "request body is too large")
			return
		}
		writeAPIError(w, request, http.StatusBadRequest, "INVALID_INPUT", "request body is invalid")
		return
	}
	if input.Purpose != sessions.PurposeBrowser && input.Purpose != sessions.PurposeDesktop {
		writeAPIError(w, request, http.StatusBadRequest, "INVALID_INPUT", "session purpose is invalid")
		return
	}

	sourceIP := clientIP(request, handler.trustedProxyCIDRs)
	if !handler.loginLimiter.Allow(input.Username, sourceIP) {
		writeAPIError(w, request, http.StatusTooManyRequests, "RATE_LIMITED", "too many login attempts")
		return
	}

	result, err := handler.authentication.Login(request.Context(), LoginAttempt{
		Username:  input.Username,
		Password:  input.Password,
		Purpose:   input.Purpose,
		DeviceID:  input.DeviceID,
		RequestID: requestID(request),
		SourceIP:  sourceIP,
	})
	if errors.Is(err, ErrInvalidCredentials) {
		writeAPIError(w, request, http.StatusUnauthorized, "INVALID_CREDENTIALS", "invalid username or password")
		return
	}
	if err != nil {
		writeAPIError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "authentication service unavailable")
		return
	}

	response := loginResponse{User: toPublicUser(result.User), ExpiresAt: result.ExpiresAt}
	if input.Purpose == sessions.PurposeBrowser {
		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookieName,
			Value:    result.AccessToken,
			Path:     "/",
			Expires:  result.ExpiresAt,
			MaxAge:   int(handler.sessionTTL / time.Second),
			Secure:   handler.cookieSecure,
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})
	} else {
		response.AccessToken = result.AccessToken
	}
	writeJSON(w, http.StatusOK, response)
}

func (handler *authHandler) loadSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		rawToken, purpose, state := requestCredential(request)
		if state == credentialAbsent {
			next.ServeHTTP(w, request)
			return
		}
		if state == credentialInvalid {
			contextWithError := context.WithValue(request.Context(), sessionLoadErrorKey{}, ErrUnauthenticated)
			next.ServeHTTP(w, request.WithContext(contextWithError))
			return
		}

		authenticated, err := handler.authentication.Authenticate(request.Context(), rawToken, purpose)
		if err != nil {
			if !errors.Is(err, ErrUnauthenticated) {
				err = ErrAuthenticationService
			}
			contextWithError := context.WithValue(request.Context(), sessionLoadErrorKey{}, err)
			next.ServeHTTP(w, request.WithContext(contextWithError))
			return
		}
		authenticated.RawToken = rawToken
		contextWithSession := context.WithValue(request.Context(), authenticatedSessionKey{}, authenticated)
		next.ServeHTTP(w, request.WithContext(contextWithSession))
	})
}

func (handler *authHandler) logout(w http.ResponseWriter, request *http.Request) {
	authenticated, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
	if !ok {
		writeSessionError(w, request)
		return
	}
	err := handler.authentication.Logout(request.Context(), LogoutAttempt{
		UserID:    authenticated.User.ID,
		SessionID: authenticated.Session.ID,
		RawToken:  authenticated.RawToken,
		RequestID: requestID(request),
		SourceIP:  clientIP(request, handler.trustedProxyCIDRs),
	})
	if errors.Is(err, ErrUnauthenticated) {
		writeAPIError(w, request, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication is required")
		return
	}
	if err != nil {
		writeAPIError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "authentication service unavailable")
		return
	}
	if authenticated.Session.Purpose == sessions.PurposeBrowser {
		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookieName,
			Value:    "",
			Path:     "/",
			Expires:  time.Unix(1, 0).UTC(),
			MaxAge:   -1,
			Secure:   handler.cookieSecure,
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *authHandler) me(w http.ResponseWriter, request *http.Request) {
	authenticated, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
	if !ok {
		writeSessionError(w, request)
		return
	}
	writeJSON(w, http.StatusOK, toPublicUser(authenticated.User))
}

type authenticatedSessionKey struct{}
type sessionLoadErrorKey struct{}

// RequireSession protects next with an already-loaded session of purpose.
// The router must install the authentication loader before this middleware.
func RequireSession(purpose string, next http.Handler) http.Handler {
	return noStore(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		authenticated, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
		if !ok || authenticated.Session.Purpose != purpose {
			writeSessionError(w, request)
			return
		}
		next.ServeHTTP(w, request)
	}))
}

func requireAnySession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if _, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession); !ok {
			writeSessionError(w, request)
			return
		}
		next.ServeHTTP(w, request)
	})
}

func writeSessionError(w http.ResponseWriter, request *http.Request) {
	loadError, _ := request.Context().Value(sessionLoadErrorKey{}).(error)
	if errors.Is(loadError, ErrAuthenticationService) {
		writeAPIError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "authentication service unavailable")
		return
	}
	writeAPIError(w, request, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication is required")
}

func requestID(request *http.Request) string {
	requestID := middleware.GetReqID(request.Context())
	if requestID == "" {
		return "request-unknown"
	}
	return requestID
}

type credentialState uint8

const (
	credentialAbsent credentialState = iota
	credentialPresent
	credentialInvalid
)

func requestCredential(request *http.Request) (string, string, credentialState) {
	cookie, cookieErr := request.Cookie(sessionCookieName)
	hasCookie := cookieErr == nil && cookie.Value != ""
	authorization := strings.TrimSpace(request.Header.Get("Authorization"))
	hasAuthorization := authorization != ""
	if hasCookie && hasAuthorization {
		return "", "", credentialInvalid
	}
	if hasCookie {
		return cookie.Value, sessions.PurposeBrowser, credentialPresent
	}
	if !hasAuthorization {
		return "", "", credentialAbsent
	}
	fields := strings.Fields(authorization)
	if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || fields[1] == "" {
		return "", "", credentialInvalid
	}
	return fields[1], sessions.PurposeDesktop, credentialPresent
}

func clientIP(request *http.Request, trustedProxyCIDRs []netip.Prefix) string {
	direct, ok := parseRemoteIP(request.RemoteAddr)
	if !ok {
		return ""
	}
	if !addressInPrefixes(direct, trustedProxyCIDRs) {
		return direct.String()
	}

	forwarded := strings.Split(request.Header.Get("X-Forwarded-For"), ",")
	for index := len(forwarded) - 1; index >= 0; index-- {
		candidate, err := netip.ParseAddr(strings.TrimSpace(forwarded[index]))
		if err != nil {
			continue
		}
		candidate = candidate.Unmap()
		if !addressInPrefixes(candidate, trustedProxyCIDRs) {
			return candidate.String()
		}
	}
	return direct.String()
}

func parseRemoteIP(remoteAddress string) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(remoteAddress)
	if err != nil {
		host = remoteAddress
	}
	address, err := netip.ParseAddr(strings.TrimSpace(host))
	if err != nil {
		return netip.Addr{}, false
	}
	return address.Unmap(), true
}

func addressInPrefixes(address netip.Addr, prefixes []netip.Prefix) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func toPublicUser(user users.User) publicUser {
	return publicUser{
		ID:          user.ID,
		Username:    user.Username,
		Role:        user.Role,
		Status:      user.Status,
		CreatedAt:   user.CreatedAt,
		UpdatedAt:   user.UpdatedAt,
		LastLoginAt: user.LastLoginAt,
	}
}
