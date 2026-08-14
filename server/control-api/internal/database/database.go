package database

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

const databasePingTimeout = 5 * time.Second

//go:embed migrations/*.sql
var migrations embed.FS

// Open creates a bounded PostgreSQL pool and verifies that it can be reached.
func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("invalid database pool configuration")
	}
	poolConfig.MaxConns = 10
	poolConfig.MinConns = 1

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("open database pool: %w", err)
	}

	pingContext, cancel := context.WithTimeout(ctx, databasePingTimeout)
	defer cancel()
	if err := pool.Ping(pingContext); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	return pool, nil
}

// Migrate applies every embedded PostgreSQL schema migration.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set migration dialect: %w", err)
	}
	goose.SetBaseFS(migrations)

	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		return fmt.Errorf("apply database migrations: %w", err)
	}
	return nil
}
