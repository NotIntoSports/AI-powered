//go:build tools

package dependencies

import (
	_ "github.com/jackc/pgx/v5"
	_ "github.com/pressly/goose/v3"
	_ "golang.org/x/crypto/bcrypt"
)
