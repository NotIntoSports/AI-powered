package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/ai-interviewer/ai-powered/control-api/internal/identity"
	"github.com/ai-interviewer/ai-powered/control-api/internal/password"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/go-chi/chi/v5"
)

type UserAdmin interface {
	ListUsers(ctx context.Context, actor users.User) ([]users.User, error)
	CreateUser(ctx context.Context, actor users.User, username, plainPassword string, role users.Role) (users.User, error)
	SetUserStatus(ctx context.Context, actor users.User, userID string, status users.Status) error
	ResetPassword(ctx context.Context, actor users.User, userID, newPassword string) error
	RevokeUserSessions(ctx context.Context, actor users.User, userID, preserveSessionID string) error
}

type createUserRequest struct {
	Username string     `json:"username"`
	Password string     `json:"password"`
	Role     users.Role `json:"role"`
}

type patchUserRequest struct {
	Status users.Status `json:"status"`
}

type resetPasswordRequest struct {
	Password string `json:"password"`
}

type revokeSessionsRequest struct {
	PreserveCurrent bool `json:"preserveCurrent"`
}

type adminUsersHandler struct {
	admin UserAdmin
}

func newAdminUsersHandler(admin UserAdmin) *adminUsersHandler {
	return &adminUsersHandler{admin: admin}
}

func requireAdministrator(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		authenticated, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
		if !ok {
			writeSessionError(w, request)
			return
		}
		if authenticated.User.Role != users.RoleAdmin || authenticated.User.Status != users.StatusActive {
			writeAPIError(w, request, http.StatusForbidden, "FORBIDDEN", "administrator access is required")
			return
		}
		next.ServeHTTP(w, request)
	})
}

func (handler *adminUsersHandler) list(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	listed, err := handler.admin.ListUsers(request.Context(), actor)
	if !writeAdminError(w, request, err) {
		return
	}
	public := make([]publicUser, 0, len(listed))
	for _, user := range listed {
		public = append(public, toPublicUser(user))
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminUsersHandler) create(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	input := createUserRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	if input.Role != users.RoleAdmin && input.Role != users.RoleOperator {
		writeAPIError(w, request, http.StatusUnprocessableEntity, "INVALID_INPUT", "user role is invalid")
		return
	}
	created, err := handler.admin.CreateUser(request.Context(), actor, input.Username, input.Password, input.Role)
	if !writeAdminError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusCreated, toPublicUser(created))
}

func (handler *adminUsersHandler) patch(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	input := patchUserRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	if input.Status != users.StatusActive && input.Status != users.StatusDisabled {
		writeAPIError(w, request, http.StatusUnprocessableEntity, "INVALID_INPUT", "user status is invalid")
		return
	}
	err := handler.admin.SetUserStatus(request.Context(), actor, chi.URLParam(request, "id"), input.Status)
	if !writeAdminError(w, request, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *adminUsersHandler) resetPassword(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	input := resetPasswordRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	err := handler.admin.ResetPassword(request.Context(), actor, chi.URLParam(request, "id"), input.Password)
	if !writeAdminError(w, request, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *adminUsersHandler) revokeSessions(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	authenticated, _ := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
	input := revokeSessionsRequest{}
	if request.Body != nil && request.ContentLength != 0 {
		if err := decodeBoundedJSON(w, request, &input); err != nil {
			writeJSONDecodeError(w, request, err)
			return
		}
	}
	targetID := chi.URLParam(request, "id")
	preserveSessionID := ""
	if input.PreserveCurrent && authenticated.User.ID == targetID {
		preserveSessionID = authenticated.Session.ID
	}
	err := handler.admin.RevokeUserSessions(request.Context(), actor, targetID, preserveSessionID)
	if !writeAdminError(w, request, err) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func requestActor(w http.ResponseWriter, request *http.Request) (users.User, bool) {
	authenticated, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
	if !ok {
		writeSessionError(w, request)
		return users.User{}, false
	}
	return authenticated.User, true
}

func writeJSONDecodeError(w http.ResponseWriter, request *http.Request, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeAPIError(w, request, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "request body is too large")
		return
	}
	writeAPIError(w, request, http.StatusBadRequest, "INVALID_INPUT", "request body is invalid")
}

func writeAdminError(w http.ResponseWriter, request *http.Request, err error) bool {
	if err == nil {
		return true
	}
	switch {
	case errors.Is(err, identity.ErrForbidden):
		writeAPIError(w, request, http.StatusForbidden, "FORBIDDEN", "administrator access is required")
	case errors.Is(err, users.ErrUsernameTaken):
		writeAPIError(w, request, http.StatusConflict, "USERNAME_TAKEN", "username is already taken")
	case errors.Is(err, users.ErrLastAdmin):
		writeAPIError(w, request, http.StatusConflict, "LAST_ADMIN_REQUIRED", "the last active administrator cannot be disabled")
	case errors.Is(err, users.ErrUserNotFound):
		writeAPIError(w, request, http.StatusNotFound, "USER_NOT_FOUND", "user was not found")
	case errors.Is(err, users.ErrInvalidUsername),
		errors.Is(err, users.ErrInvalidRole),
		errors.Is(err, users.ErrInvalidStatus),
		errors.Is(err, users.ErrInvalidPassword),
		errors.Is(err, password.ErrInvalidPassword):
		writeAPIError(w, request, http.StatusUnprocessableEntity, "INVALID_INPUT", "request body is invalid")
	default:
		writeAPIError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "administrator service unavailable")
	}
	return false
}
