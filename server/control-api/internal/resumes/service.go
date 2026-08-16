package resumes

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ai-interviewer/ai-powered/control-api/internal/audit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/objectstore"
	"github.com/ai-interviewer/ai-powered/control-api/internal/secretbox"
	"github.com/ai-interviewer/ai-powered/control-api/internal/settings"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

const (
	MaxBytes          = 10 << 20
	presignExpiry     = time.Hour
	maxCandidateRunes = 50
	maxFilenameRunes  = 200
	resumeSelectSQL   = `
		select
			r.id, r.uploaded_by_user_id, coalesce(u.username, ''), r.candidate_name,
			r.original_filename, r.content_type, r.size_bytes, r.object_key, r.sha256, r.created_at,
			r.index_status, coalesce(r.index_error, ''), r.indexed_at, r.knowledge_provider,
			coalesce(r.external_doc_id, '')
		from resumes as r
		left join users as u on u.id = r.uploaded_by_user_id
	`
)

var (
	ErrNotConfigured = errors.New("object storage is not configured")
	ErrInvalidInput  = errors.New("invalid resume upload")
	ErrTooLarge      = errors.New("resume is too large")
	ErrUnsupported   = errors.New("unsupported resume type")
	ErrNotFound      = errors.New("resume not found")
	ErrStore         = errors.New("resume store unavailable")
)

type Record struct {
	ID                 string     `json:"id"`
	UploadedByUserID   string     `json:"uploadedByUserId"`
	UploadedByUsername string     `json:"uploadedByUsername"`
	CandidateName      string     `json:"candidateName"`
	OriginalFilename   string     `json:"originalFilename"`
	ContentType        string     `json:"contentType"`
	SizeBytes          int64      `json:"sizeBytes"`
	ObjectKey          string     `json:"-"`
	SHA256             string     `json:"-"`
	CreatedAt          time.Time  `json:"createdAt"`
	IndexStatus        string     `json:"indexStatus"`
	IndexError         string     `json:"indexError,omitempty"`
	IndexedAt          *time.Time `json:"indexedAt,omitempty"`
	KnowledgeProvider  string     `json:"-"`
	ExternalDocID      string     `json:"-"`
}

type UploadInput struct {
	CandidateName string
	Filename      string
	ContentType   string
	Body          io.Reader
}

type ObjectClient interface {
	ListBuckets(ctx context.Context, creds objectstore.Credentials) ([]objectstore.Bucket, error)
	HeadBucket(ctx context.Context, creds objectstore.Credentials) error
	PutObject(ctx context.Context, creds objectstore.Credentials, key, contentType string, body io.Reader) error
	GetObject(ctx context.Context, creds objectstore.Credentials, key string) ([]byte, error)
	PresignGet(ctx context.Context, creds objectstore.Credentials, key string, expiry time.Duration) (string, error)
	DeleteObject(ctx context.Context, creds objectstore.Credentials, key string) error
}

type Service struct {
	db      database.DBTX
	box     *secretbox.Box
	objects ObjectClient
}

func NewService(db database.DBTX, box *secretbox.Box, objects ObjectClient) *Service {
	if objects == nil {
		objects = objectstore.NewCOS()
	}
	return &Service{db: db, box: box, objects: objects}
}

func (s *Service) List(ctx context.Context, uploadedByUserID string) ([]Record, error) {
	query := resumeSelectSQL + `
		order by r.created_at desc
		limit 200
	`
	args := []any{}
	if uploadedByUserID != "" {
		query = resumeSelectSQL + `
			where r.uploaded_by_user_id = $1
			order by r.created_at desc
			limit 200
		`
		args = append(args, uploadedByUserID)
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, ErrStore
	}
	defer rows.Close()
	records := make([]Record, 0)
	for rows.Next() {
		record := Record{}
		if err := scanResume(rows, &record); err != nil {
			return nil, ErrStore
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, ErrStore
	}
	return records, nil
}

func (s *Service) Upload(ctx context.Context, actor users.User, requestID string, input UploadInput) (Record, error) {
	creds, err := s.credentials(ctx)
	if err != nil {
		return Record{}, err
	}
	filename, contentType, payload, err := readResumeFile(input)
	if err != nil {
		return Record{}, err
	}
	id, err := randomID()
	if err != nil {
		return Record{}, ErrStore
	}
	sum := sha256.Sum256(payload)
	digest := hex.EncodeToString(sum[:])
	objectKey := "resumes/" + time.Now().UTC().Format("2006/01/02") + "/" + id + "/" + filename
	if err := s.objects.PutObject(ctx, creds, objectKey, contentType, bytes.NewReader(payload)); err != nil {
		return Record{}, err
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	candidateName := strings.TrimSpace(input.CandidateName)
	if utf8.RuneCountInString(candidateName) > maxCandidateRunes {
		return Record{}, ErrInvalidInput
	}
	_, err = s.db.Exec(ctx, `
		insert into resumes (
			id, uploaded_by_user_id, candidate_name, original_filename, content_type,
			size_bytes, object_key, sha256, created_at
		) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
	`, id, actor.ID, candidateName, filename, contentType, int64(len(payload)), objectKey, digest, now)
	if err != nil {
		return Record{}, ErrStore
	}
	_ = audit.NewStore(s.db).Append(ctx, audit.Event{
		ActorUserID: actor.ID,
		Action:      audit.ActionResumeUploaded,
		TargetType:  "resume",
		TargetID:    id,
		Result:      audit.ResultSuccess,
		RequestID:   requestID,
		Metadata: map[string]any{
			"contentType": contentType,
			"sizeBytes":   len(payload),
		},
	})
	return Record{
		ID:                 id,
		UploadedByUserID:   actor.ID,
		UploadedByUsername: actor.Username,
		CandidateName:      candidateName,
		OriginalFilename:   filename,
		ContentType:        contentType,
		SizeBytes:          int64(len(payload)),
		ObjectKey:          objectKey,
		SHA256:             digest,
		CreatedAt:          now,
		IndexStatus:        "pending",
		KnowledgeProvider:  "local-pgvector",
	}, nil
}

func (s *Service) DownloadURL(ctx context.Context, actor users.User, id string) (string, Record, error) {
	record, err := s.getAccessible(ctx, actor, id)
	if err != nil {
		return "", Record{}, err
	}
	creds, err := s.credentials(ctx)
	if err != nil {
		return "", Record{}, err
	}
	url, err := s.objects.PresignGet(ctx, creds, record.ObjectKey, presignExpiry)
	if err != nil {
		return "", Record{}, err
	}
	return url, record, nil
}

func (s *Service) Delete(ctx context.Context, actor users.User, requestID, id string) error {
	record, err := s.getAccessible(ctx, actor, id)
	if err != nil {
		return err
	}
	creds, err := s.credentials(ctx)
	if err != nil {
		return err
	}
	if err := s.objects.DeleteObject(ctx, creds, record.ObjectKey); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `delete from resumes where id = $1`, id); err != nil {
		return ErrStore
	}
	_ = audit.NewStore(s.db).Append(ctx, audit.Event{
		ActorUserID: actor.ID,
		Action:      audit.ActionResumeDeleted,
		TargetType:  "resume",
		TargetID:    id,
		Result:      audit.ResultSuccess,
		RequestID:   requestID,
		Metadata: map[string]any{
			"originalFilename": record.OriginalFilename,
			"sizeBytes":        record.SizeBytes,
		},
	})
	return nil
}

func (s *Service) GetAccessible(ctx context.Context, actor users.User, id string) (Record, error) {
	return s.getAccessible(ctx, actor, id)
}

func (s *Service) FetchObject(ctx context.Context, objectKey string) ([]byte, error) {
	creds, err := s.credentials(ctx)
	if err != nil {
		return nil, err
	}
	return s.objects.GetObject(ctx, creds, objectKey)
}

func (s *Service) BeginIndex(ctx context.Context, resumeID string) (Record, bool, error) {
	record, err := s.get(ctx, resumeID)
	if err != nil {
		return Record{}, false, err
	}
	tag, err := s.db.Exec(ctx, `
		update resumes
		set index_status = 'indexing', index_error = null
		where id = $1 and index_status in ('pending', 'failed', 'skipped')
	`, resumeID)
	if err != nil {
		return Record{}, false, ErrStore
	}
	if tag.RowsAffected() == 0 {
		return record, false, nil
	}
	record.IndexStatus = "indexing"
	record.IndexError = ""
	return record, true, nil
}

func (s *Service) FinishIndex(ctx context.Context, resumeID, status, errorText, provider, externalDocID string) error {
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, err := s.db.Exec(ctx, `
		update resumes
		set index_status = $2,
		    index_error = nullif($3, ''),
		    indexed_at = $4,
		    knowledge_provider = $5,
		    external_doc_id = nullif($6, '')
		where id = $1
	`, resumeID, status, errorText, now, provider, externalDocID)
	if err != nil {
		return ErrStore
	}
	return nil
}

func (s *Service) ResetIndex(ctx context.Context, resumeID string) error {
	_, err := s.db.Exec(ctx, `
		update resumes
		set index_status = 'pending',
		    index_error = null,
		    indexed_at = null,
		    external_doc_id = null
		where id = $1
	`, resumeID)
	if err != nil {
		return ErrStore
	}
	return nil
}

func (s *Service) getAccessible(ctx context.Context, actor users.User, id string) (Record, error) {
	record, err := s.get(ctx, id)
	if err != nil {
		return Record{}, err
	}
	if !canAccessResume(actor, record) {
		return Record{}, ErrNotFound
	}
	return record, nil
}

func canAccessResume(actor users.User, record Record) bool {
	if actor.Role == users.RoleAdmin {
		return true
	}
	return actor.ID != "" && actor.ID == record.UploadedByUserID
}

func (s *Service) get(ctx context.Context, id string) (Record, error) {
	record := Record{}
	err := scanResume(s.db.QueryRow(ctx, resumeSelectSQL+`
		where r.id = $1
	`, id), &record)
	if errors.Is(err, pgx.ErrNoRows) {
		return Record{}, ErrNotFound
	}
	if err != nil {
		return Record{}, ErrStore
	}
	return record, nil
}

type resumeScanner interface {
	Scan(dest ...any) error
}

func scanResume(row resumeScanner, record *Record) error {
	var indexedAt sql.NullTime
	err := row.Scan(
		&record.ID,
		&record.UploadedByUserID,
		&record.UploadedByUsername,
		&record.CandidateName,
		&record.OriginalFilename,
		&record.ContentType,
		&record.SizeBytes,
		&record.ObjectKey,
		&record.SHA256,
		&record.CreatedAt,
		&record.IndexStatus,
		&record.IndexError,
		&indexedAt,
		&record.KnowledgeProvider,
		&record.ExternalDocID,
	)
	if err != nil {
		return err
	}
	if indexedAt.Valid {
		value := indexedAt.Time
		record.IndexedAt = &value
	}
	return nil
}

func (s *Service) credentials(ctx context.Context) (objectstore.Credentials, error) {
	store := settings.NewStore(s.db, s.box)
	record, err := store.GetStorage(ctx)
	if errors.Is(err, settings.ErrNotConfigured) {
		return objectstore.Credentials{}, ErrNotConfigured
	}
	if err != nil {
		return objectstore.Credentials{}, err
	}
	secretKey, err := store.DecryptSecretKey(record)
	if err != nil {
		return objectstore.Credentials{}, err
	}
	public := settings.PublicStorageFrom(record, err)
	if !public.Available || secretKey == "" {
		return objectstore.Credentials{}, ErrNotConfigured
	}
	return objectstore.Credentials{
		SecretID:  record.SecretID,
		SecretKey: secretKey,
		Region:    record.Region,
		Bucket:    record.Bucket,
	}, nil
}

func readResumeFile(input UploadInput) (string, string, []byte, error) {
	filename := sanitizeFilename(input.Filename)
	if filename == "" {
		return "", "", nil, ErrInvalidInput
	}
	limited := io.LimitReader(input.Body, MaxBytes+1)
	payload, err := io.ReadAll(limited)
	if err != nil {
		return "", "", nil, ErrInvalidInput
	}
	if len(payload) == 0 {
		return "", "", nil, ErrInvalidInput
	}
	if len(payload) > MaxBytes {
		return "", "", nil, ErrTooLarge
	}
	contentType := detectResumeType(filename, payload, input.ContentType)
	if contentType == "" {
		return "", "", nil, ErrUnsupported
	}
	return filename, contentType, payload, nil
}

func detectResumeType(filename string, payload []byte, declared string) string {
	ext := strings.ToLower(path.Ext(filename))
	sniffed := http.DetectContentType(payload)
	switch ext {
	case ".pdf":
		if bytes.HasPrefix(payload, []byte("%PDF")) {
			return "application/pdf"
		}
	case ".docx":
		if bytes.HasPrefix(payload, []byte("PK")) {
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
		}
	case ".doc":
		if sniffed == "application/msword" || bytes.HasPrefix(payload, []byte{0xD0, 0xCF, 0x11, 0xE0}) {
			return "application/msword"
		}
	}
	declared = strings.ToLower(strings.TrimSpace(declared))
	if ext == ".pdf" && strings.Contains(declared, "pdf") && bytes.HasPrefix(payload, []byte("%PDF")) {
		return "application/pdf"
	}
	return ""
}

func sanitizeFilename(raw string) string {
	base := path.Base(strings.ReplaceAll(raw, "\\", "/"))
	base = strings.TrimSpace(base)
	if base == "." || base == ".." {
		return ""
	}
	cleaned := strings.Map(func(char rune) rune {
		if char == '.' || char == '-' || char == '_' || unicodeSafe(char) {
			return char
		}
		return '_'
	}, base)
	if utf8.RuneCountInString(cleaned) > maxFilenameRunes {
		runes := []rune(cleaned)
		cleaned = string(runes[:maxFilenameRunes])
	}
	return cleaned
}

func unicodeSafe(char rune) bool {
	return (char >= 'a' && char <= 'z') ||
		(char >= 'A' && char <= 'Z') ||
		(char >= '0' && char <= '9') ||
		char > 127
}

func randomID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}
