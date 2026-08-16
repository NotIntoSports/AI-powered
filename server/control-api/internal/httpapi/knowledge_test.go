package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"context"
	"github.com/ai-interviewer/ai-powered/control-api/internal/knowledge"
	"github.com/ai-interviewer/ai-powered/control-api/internal/resumes"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

type fakeKnowledgeAdmin struct {
	record resumes.Record
	result knowledge.SearchResult
}

func (f *fakeKnowledgeAdmin) EnqueueIndex(string, string, string) {}

func (f *fakeKnowledgeAdmin) DeleteDocument(context.Context, string, string) error { return nil }

func (f *fakeKnowledgeAdmin) Status(context.Context, users.User, string) (resumes.Record, error) {
	return f.record, nil
}

func (f *fakeKnowledgeAdmin) Search(context.Context, users.User, knowledge.SearchInput) knowledge.SearchResult {
	if f.result.Chunks == nil {
		return knowledge.EmptyResult()
	}
	return f.result
}

func (f *fakeKnowledgeAdmin) Reindex(context.Context, users.User, string, string) error {
	return nil
}

func TestClientKnowledgeSearchRequiresSession(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: &fakeAuthentication{},
		ResumeAdmin:    &fakeResumeAdmin{},
		KnowledgeAdmin: &fakeKnowledgeAdmin{},
	})
	response := performRequest(t, router, http.MethodPost, "/api/v1/client/knowledge/search", `{"query":"经历","resumeId":"r1"}`, nil)
	assertAPIError(t, response, http.StatusUnauthorized, "UNAUTHENTICATED")
}

func TestClientKnowledgeSearchReturnsEmptyWhenNotReady(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: desktopOperatorAuth(),
		ResumeAdmin:    &fakeResumeAdmin{},
		KnowledgeAdmin: &fakeKnowledgeAdmin{result: knowledge.EmptyResult()},
	})
	response := performRequest(t, router, http.MethodPost, "/api/v1/client/knowledge/search", `{"query":"经历","resumeId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, map[string]string{
		"Authorization": "Bearer desktop-token",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body knowledge.SearchResult
	decodeJSON(t, response, &body)
	if body.Chunks == nil || len(body.Chunks) != 0 {
		t.Fatalf("chunks=%v", body.Chunks)
	}
	if raw := response.Body.String(); strings.Contains(raw, "objectKey") || strings.Contains(raw, "embedding") {
		t.Fatalf("response leaked internals: %s", raw)
	}
}

func TestClientResumeStatusOmitsObjectKey(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: desktopOperatorAuth(),
		ResumeAdmin:    &fakeResumeAdmin{},
		KnowledgeAdmin: &fakeKnowledgeAdmin{record: resumes.Record{ID: "r1", IndexStatus: "pending"}},
	})
	response := performRequest(t, router, http.MethodGet, "/api/v1/client/resumes/r1/status", "", map[string]string{
		"Authorization": "Bearer desktop-token",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["indexStatus"] != "pending" {
		t.Fatalf("body=%v", body)
	}
	if _, ok := body["objectKey"]; ok {
		t.Fatal("objectKey should not be present")
	}
}
