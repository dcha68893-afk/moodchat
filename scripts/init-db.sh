#!/bin/bash

# Database Initialization Script
# Run all migrations and seeders in proper order

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if required environment variables are set
check_env_vars() {
    local required_vars=("DATABASE_URL" "NODE_ENV")
    local missing_vars=()
    
    for var in "${required_vars[@]}"; do
        if [ -z "${!var}" ]; then
            missing_vars+=("$var")
        fi
    done
    
    if [ ${#missing_vars[@]} -gt 0 ]; then
        log_error "Missing required environment variables: ${missing_vars[*]}"
        exit 1
    fi
}

# Load environment variables from .env file if it exists
load_env() {
    if [ -f ".env" ]; then
        log_info "Loading environment variables from .env file"
        set -a
        source .env
        set +a
    elif [ -f ".env.example" ]; then
        log_warn ".env file not found, using .env.example as reference"
        log_info "Please create a .env file with your actual configuration"
    fi
}

# Wait for database to be ready
wait_for_db() {
    local max_attempts=30
    local attempt=1
    
    log_info "Waiting for database to be ready..."
    
    until psql "$DATABASE_URL" -c '\q' 2>/dev/null; do
        if [ $attempt -eq $max_attempts ]; then
            log_error "Database is not ready after $max_attempts attempts"
            exit 1
        fi
        
        log_info "Attempt $attempt/$max_attempts: Database not ready, waiting 2 seconds..."
        sleep 2
        attempt=$((attempt + 1))
    done
    
    log_success "Database connection established"
}

# Run migrations
run_migrations() {
    local migration_order=(
        "001_initial_schema.js"
        "002_friends_schema.js"
        "003_chats_messages_schema.js"
        "004_calls_schema.js"
        "005_moods_schema.js"
        "006_media_schema.js"
        "007_notifications_schema.js"
    )
    
    log_info "Starting database migrations..."
    
    for migration in "${migration_order[@]}"; do
        log_info "Running migration: $migration"
        
        if npx sequelize-cli db:migrate --migrations-path ./db/migrations --migration-file-name "$migration"; then
            log_success "Migration $migration completed successfully"
        else
            log_error "Migration $migration failed"
            exit 1
        fi
    done
    
    log_success "All migrations completed successfully"
}

# Run seeders
run_seeders() {
    local seeder_file="initial_seed.js"
    
    log_info "Running database seeders..."
    
    if [ -f "./db/seeders/$seeder_file" ]; then
        log_info "Running seeder: $seeder_file"
        
        if npx sequelize-cli db:seed:all --seeders-path ./db/seeders; then
            log_success "Seeder $seeder_file completed successfully"
        else
            log_error "Seeder $seeder_file failed"
            exit 1
        fi
    else
        log_warn "Seeder file $seeder_file not found, skipping seeding"
    fi
}

# Create database if it doesn't exist
create_database() {
    local db_name=$(echo "$DATABASE_URL" | sed -n 's/.*\/\([^\/]*\)$/\1/p')
    local base_url=$(echo "$DATABASE_URL" | sed 's/\/[^\/]*$//')
    
    log_info "Checking if database '$db_name' exists..."
    
    if ! psql "$base_url/$db_name" -c '\q' 2>/dev/null; then
        log_info "Database '$db_name' does not exist, creating..."
        
        if psql "$base_url/template1" -c "CREATE DATABASE $db_name;"; then
            log_success "Database '$db_name' created successfully"
        else
            log_error "Failed to create database '$db_name'"
            exit 1
        fi
    else
        log_success "Database '$db_name' already exists"
    fi
}

# Backup existing database (optional)
backup_database() {
    local backup_dir="./backups"
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_file="$backup_dir/backup_${timestamp}.sql"
    
    if [ "$BACKUP_BEFORE_INIT" = "true" ]; then
        log_info "Creating database backup..."
        
        mkdir -p "$backup_dir"
        
        if pg_dump "$DATABASE_URL" > "$backup_file"; then
            log_success "Backup created: $backup_file"
        else
            log_error "Failed to create backup"
            exit 1
        fi
    fi
}

# Show database info
show_database_info() {
    log_info "Database Information:"
    
    # Get database size
    local db_size=$(psql "$DATABASE_URL" -t -c "SELECT pg_size_pretty(pg_database_size(current_database()));")
    log_info "  Database size: $db_size"
    
    # Get table counts
    log_info "  Table counts:"
    psql "$DATABASE_URL" -c "
        SELECT 
            schemaname as schema,
            tablename as table,
            pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) as size
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename;
    " | while read -r line; do
        if [[ $line != *"schema | table | size"* ]] && [[ $line != *"---"* ]] && [[ ! -z $line ]]; then
            log_info "    $line"
        fi
    done
}

# Main execution
main() {
    log_info "Starting database initialization..."
    log_info "Environment: $NODE_ENV"
    
    # Load environment variables
    load_env
    
    # Check required environment variables
    check_env_vars
    
    # Create database backup if enabled
    backup_database
    
    # Create database if it doesn't exist
    create_database
    
    # Wait for database to be ready
    wait_for_db
    
    # Run migrations
    run_migrations
    
    # Run seeders if SEED_DATA is true
    if [ "$SEED_DATA" = "true" ]; then
        run_seeders
    else
        log_info "Skipping seeders (SEED_DATA is not true)"
    fi
    
    # Show database information
    show_database_info
    
    log_success "Database initialization completed successfully!"
}

# Handle script arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --seed)
            SEED_DATA="true"
            shift
            ;;
        --backup)
            BACKUP_BEFORE_INIT="true"
            shift
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo "Options:"
            echo "  --seed      Run database seeders after migrations"
            echo "  --backup    Create database backup before initialization"
            echo "  --help      Show this help message"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Run main function
main