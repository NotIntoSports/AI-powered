package objectstore

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

type Bucket struct {
	Name   string `json:"name"`
	Region string `json:"region"`
}

type Credentials struct {
	SecretID  string
	SecretKey string
	Region    string
	Bucket    string
}

type COS struct {
	httpClient *http.Client
}

func NewCOS() *COS {
	return &COS{
		httpClient: &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *COS) client(creds Credentials, withBucket bool) *cos.Client {
	transport := &cos.AuthorizationTransport{
		SecretID:  creds.SecretID,
		SecretKey: creds.SecretKey,
		Transport: c.httpClient.Transport,
	}
	httpClient := &http.Client{
		Timeout:   c.httpClient.Timeout,
		Transport: transport,
	}
	baseURL := &cos.BaseURL{}
	if withBucket && creds.Bucket != "" && creds.Region != "" {
		bucketURL, err := url.Parse(fmt.Sprintf("https://%s.cos.%s.myqcloud.com", creds.Bucket, creds.Region))
		if err == nil {
			baseURL.BucketURL = bucketURL
		}
	}
	serviceURL, err := url.Parse("https://service.cos.myqcloud.com")
	if err == nil {
		baseURL.ServiceURL = serviceURL
	}
	return cos.NewClient(baseURL, httpClient)
}

func (c *COS) ListBuckets(ctx context.Context, creds Credentials) ([]Bucket, error) {
	result, _, err := c.client(creds, false).Service.Get(ctx)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return []Bucket{}, nil
	}
	buckets := make([]Bucket, 0, len(result.Buckets))
	for _, bucket := range result.Buckets {
		buckets = append(buckets, Bucket{
			Name:   bucket.Name,
			Region: bucket.Region,
		})
	}
	return buckets, nil
}

func (c *COS) HeadBucket(ctx context.Context, creds Credentials) error {
	if strings.TrimSpace(creds.Bucket) == "" || strings.TrimSpace(creds.Region) == "" {
		return fmt.Errorf("bucket and region are required")
	}
	_, err := c.client(creds, true).Bucket.Head(ctx)
	return err
}

func (c *COS) PutObject(ctx context.Context, creds Credentials, key, contentType string, body io.Reader) error {
	options := &cos.ObjectPutOptions{
		ObjectPutHeaderOptions: &cos.ObjectPutHeaderOptions{
			ContentType: contentType,
		},
	}
	_, err := c.client(creds, true).Object.Put(ctx, key, body, options)
	return err
}

func (c *COS) GetObject(ctx context.Context, creds Credentials, key string) ([]byte, error) {
	response, err := c.client(creds, true).Object.Get(ctx, key, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, (10<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(payload) > 10<<20 {
		return nil, fmt.Errorf("object exceeds resume size limit")
	}
	return payload, nil
}

func (c *COS) PresignGet(ctx context.Context, creds Credentials, key string, expiry time.Duration) (string, error) {
	presigned, err := c.client(creds, true).Object.GetPresignedURL(
		ctx,
		http.MethodGet,
		key,
		creds.SecretID,
		creds.SecretKey,
		expiry,
		nil,
	)
	if err != nil {
		return "", err
	}
	return presigned.String(), nil
}

func (c *COS) DeleteObject(ctx context.Context, creds Credentials, key string) error {
	_, err := c.client(creds, true).Object.Delete(ctx, key)
	if err == nil || cos.IsNotFoundError(err) {
		return nil
	}
	return err
}
