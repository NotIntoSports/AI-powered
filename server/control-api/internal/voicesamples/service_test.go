package voicesamples

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/objectstore"
)

type fakeObjectClient struct {
	putErr       error
	presignErr   error
	deleteErr    error
	putKey       string
	putPayload   []byte
	deletedKey   string
	presignedKey string
}

func (fake *fakeObjectClient) PutObject(_ context.Context, _ objectstore.Credentials, key, _ string, body io.Reader) error {
	fake.putKey = key
	fake.putPayload, _ = io.ReadAll(body)
	return fake.putErr
}

func (fake *fakeObjectClient) PresignGet(_ context.Context, _ objectstore.Credentials, key string, _ time.Duration) (string, error) {
	fake.presignedKey = key
	if fake.presignErr != nil {
		return "", fake.presignErr
	}
	return "https://example.invalid/sample.wav?signature=hidden", nil
}

func (fake *fakeObjectClient) DeleteObject(_ context.Context, _ objectstore.Credentials, key string) error {
	fake.deletedKey = key
	return fake.deleteErr
}

func testWAV() []byte {
	payload := make([]byte, 64)
	copy(payload[0:4], "RIFF")
	copy(payload[8:12], "WAVE")
	return payload
}

func testService(objects ObjectClient) *Service {
	return &Service{
		objects: objects,
		loadCredentials: func(context.Context) (objectstore.Credentials, error) {
			return objectstore.Credentials{SecretID: "id", SecretKey: "secret", Region: "ap-guangzhou", Bucket: "bucket"}, nil
		},
	}
}

func TestUploadStoresWAVAndReturnsPresignedURL(t *testing.T) {
	objects := &fakeObjectClient{}
	result, err := testService(objects).Upload(context.Background(), bytes.NewReader(testWAV()))
	if err != nil {
		t.Fatal(err)
	}
	if result.ID == "" || result.URL == "" || result.ExpiresIn != 1800 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if objects.putKey != objects.presignedKey || len(objects.putPayload) != len(testWAV()) {
		t.Fatalf("put=%q presign=%q bytes=%d", objects.putKey, objects.presignedKey, len(objects.putPayload))
	}
}

func TestUploadClassifiesPutFailure(t *testing.T) {
	_, err := testService(&fakeObjectClient{putErr: errors.New("cos denied")}).Upload(context.Background(), bytes.NewReader(testWAV()))
	if !errors.Is(err, ErrUpload) {
		t.Fatalf("err=%v", err)
	}
}

func TestUploadClassifiesPresignFailureAndCleansObject(t *testing.T) {
	objects := &fakeObjectClient{presignErr: errors.New("presign failed")}
	_, err := testService(objects).Upload(context.Background(), bytes.NewReader(testWAV()))
	if !errors.Is(err, ErrPresign) {
		t.Fatalf("err=%v", err)
	}
	if objects.deletedKey == "" || objects.deletedKey != objects.putKey {
		t.Fatalf("cleanup key=%q put key=%q", objects.deletedKey, objects.putKey)
	}
}

func TestDeleteClassifiesObjectFailure(t *testing.T) {
	objects := &fakeObjectClient{deleteErr: errors.New("delete failed")}
	err := testService(objects).Delete(context.Background(), "0123456789abcdef0123456789abcdef")
	if !errors.Is(err, ErrDelete) {
		t.Fatalf("err=%v", err)
	}
}

func TestReadSampleRejectsInvalidAndOversizedWAV(t *testing.T) {
	if _, err := readSample(bytes.NewReader([]byte("not wav"))); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("invalid err=%v", err)
	}
	if _, err := readSample(io.LimitReader(bytes.NewReader(append(testWAV(), bytes.Repeat([]byte{1}, MaxBytes)...)), MaxBytes+1)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized err=%v", err)
	}
}
