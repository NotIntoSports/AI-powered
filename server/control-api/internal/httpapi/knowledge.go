package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/ai-interviewer/ai-powered/control-api/internal/knowledge"
	"github.com/ai-interviewer/ai-powered/control-api/internal/resumes"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type KnowledgeAdmin interface {
	EnqueueIndex(resumeID, actorUserID, requestID string)
	DeleteDocument(ctx context.Context, resumeID, externalDocID string) error
	Status(ctx context.Context, actor users.User, resumeID string) (resumes.Record, error)
	Search(ctx context.Context, actor users.User, in knowledge.SearchInput) knowledge.SearchResult
	Reindex(ctx context.Context, actor users.User, requestID, resumeID string) error
}

type knowledgeHandler struct {
	admin KnowledgeAdmin
}

func newKnowledgeHandler(admin KnowledgeAdmin) *knowledgeHandler {
	return &knowledgeHandler{admin: admin}
}

type knowledgeSearchRequest struct {
	Query     string   `json:"query"`
	ResumeID  string   `json:"resumeId"`
	ResumeIDs []string `json:"resumeIds"`
	TopK      int      `json:"topK"`
}

type resumeIndexStatus struct {
	IndexStatus string `json:"indexStatus"`
	IndexError  string `json:"indexError,omitempty"`
	IndexedAt   any    `json:"indexedAt,omitempty"`
}

func (handler *knowledgeHandler) search(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	var body knowledgeSearchRequest
	if err := decodeBoundedJSON(w, request, &body); err != nil {
		writeJSON(w, http.StatusOK, knowledge.EmptyResult())
		return
	}
	result := handler.admin.Search(request.Context(), actor, knowledge.SearchInput{
		Query:     body.Query,
		ResumeID:  body.ResumeID,
		ResumeIDs: body.ResumeIDs,
		TopK:      body.TopK,
	})
	writeJSON(w, http.StatusOK, result)
}

func (handler *knowledgeHandler) status(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	id := strings.TrimSpace(chi.URLParam(request, "id"))
	record, err := handler.admin.Status(request.Context(), actor, id)
	if !writeResumeError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, resumeIndexStatus{
		IndexStatus: record.IndexStatus,
		IndexError:  record.IndexError,
		IndexedAt:   record.IndexedAt,
	})
}

func (handler *knowledgeHandler) reindex(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	id := strings.TrimSpace(chi.URLParam(request, "id"))
	err := handler.admin.Reindex(request.Context(), actor, middleware.GetReqID(request.Context()), id)
	if !writeResumeError(w, request, err) {
		return
	}
	record, err := handler.admin.Status(request.Context(), actor, id)
	if !writeResumeError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, record)
}
