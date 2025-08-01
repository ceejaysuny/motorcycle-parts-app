#!/bin/bash

# Motorcycle Parts Management System - Database Backup Script
# This script creates automated backups of the PostgreSQL database

set -e

# Configuration
DB_HOST=${DB_HOST:-postgres}
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-motorcycle_parts_db}
DB_USER=${DB_USER:-postgres}
BACKUP_DIR=${BACKUP_DIR:-/backups}
RETENTION_DAYS=${RETENTION_DAYS:-30}

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Generate timestamp
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/motorcycle_parts_backup_$TIMESTAMP.sql"

echo "Starting database backup at $(date)"

# Create database backup
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --no-password --verbose --clean --if-exists \
    --format=custom --compress=9 \
    --file="$BACKUP_FILE.custom"

# Also create a plain SQL backup for easier restoration
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --no-password --verbose --clean --if-exists \
    --format=plain \
    --file="$BACKUP_FILE"

# Compress the plain SQL backup
gzip "$BACKUP_FILE"

echo "Database backup completed: $BACKUP_FILE.gz"

# Clean up old backups (keep only last N days)
echo "Cleaning up backups older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -name "motorcycle_parts_backup_*.sql.gz" -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name "motorcycle_parts_backup_*.sql.custom" -mtime +$RETENTION_DAYS -delete

echo "Backup process completed at $(date)"

# Optional: Upload to cloud storage (uncomment and configure as needed)
# aws s3 cp "$BACKUP_FILE.gz" s3://your-backup-bucket/database-backups/
# gsutil cp "$BACKUP_FILE.gz" gs://your-backup-bucket/database-backups/

