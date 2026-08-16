package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/ai-interviewer/ai-powered/control-api/internal/resumes"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type ResumeAdmin interface {
	List(ctx context.Context) ([]resumes.Record, error)
	Upload(ctx context.Context, actor users.User, requestID string, input resumes.UploadInput) (resumes.Record, error)
	DownloadURL(ctx context.Context, id string) (string, resumes.Record, error)
}

type resumeHandler struct {
	admin ResumeAdmin
}

func newResumeHandler(admin ResumeAdmin) *resumeHandler {
	return &resumeHandler{admin: admin}
}

func (handler *resumeHandler) list(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	records, err := handler.admin.List(request.Context())
	if err != nil {
		writeAPIError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "unable to list resumes")
		return
	}
	writeJSON(w, http.StatusOK, records)
}

func (handler *resumeHandler) upload(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	request.Body = http.MaxBytesReader(w, request.Body, resumes.MaxBytes+1024*1024)
	if err := request.ParseMultipartForm(resumes.MaxBytes); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeAPIError(w, request, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "resume must be 10MB or smaller")
			return
		}
		writeAPIError(w, request, http.StatusBadRequest, "INVALID_INPUT", "multipart form is required")
		return
	}
	file, header, err := request.FormFile("file")
	if err != nil {
		writeAPIError(w, request, http.StatusUnprocessableEntity, "INVALID_INPUT", "resume file is required")
		return
	}
	defer file.Close()
	record, err := handler.admin.Upload(request.Context(), actor, middleware.GetReqID(request.Context()), resumes.UploadInput{
		CandidateName: request.FormValue("candidateName"),
		Filename:      header.Filename,
		ContentType:   header.Header.Get("Content-Type"),
		Body:          file,
	})
	if !writeResumeError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusCreated, record)
}

func (handler *resumeHandler) download(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	id := strings.TrimSpace(chi.URLParam(request, "id"))
	url, _, err := handler.admin.DownloadURL(request.Context(), id)
	if !writeResumeError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func writeResumeError(w http.ResponseWriter, request *http.Request, err error) bool {
	if err == nil {
		return true
	}
	switch {
	case errors.Is(err, resumes.ErrNotConfigured):
		writeAPIError(w, request, http.StatusServiceUnavailable, "STORAGE_NOT_CONFIGURED", "object storage is not configured")
	case errors.Is(err, resumes.ErrInvalidInput):
		writeAPIError(w, request, http.StatusUnprocessableEntity, "INVALID_INPUT", "resume upload is invalid")
	case errors.Is(err, resumes.ErrTooLarge):
		writeAPIError(w, request, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "resume must be 10MB or smaller")
	case errors.Is(err, resumes.ErrUnsupported):
		writeAPIError(w, request, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA", "only PDF or Word resumes are accepted")
	case errors.Is(err, resumes.ErrNotFound):
		writeAPIError(w, request, http.StatusNotFound, "RESUME_NOT_FOUND", "resume not found")
	default:
		writeAPIError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "resume service unavailable")
	}
	return false
}
