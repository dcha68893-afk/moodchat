#!/bin/bash

# MoodChat Backend Deployment Script
# Deploys the latest version of the application

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
APP_NAME="moodchat-backend"
APP_DIR="/opt/moodchat/backend"
LOG_DIR="/var/log/moodchat"
BACKUP_DIR="/opt/moodchat/backups"
ENV_FILE="$APP_DIR/.env"
PM2_APP_NAME="moodchat-backend"
BRANCH="main"
GIT_REPO="https://github.com/your-org/moodchat-backend.git"

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_warn() {
    echo -e "${YELLOW}[WARNING]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

# Check if running as root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        log_warn "Running as root is not recommended. Consider using a service account."
        read -p "Continue anyway? (y/n): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    local missing_tools=()
    
    # Check for required tools
    for tool in git node npm pm2 psql nginx; do
        if ! command -v $tool &> /dev/null; then
            missing_tools+=("$tool")
        fi
    done
    
    if [ ${#missing_tools[@]} -gt 0 ]; then
        log_error "Missing required tools: ${missing_tools[*]}"
        exit 1
    fi
    
    log_success "All prerequisites met"
}

# Create necessary directories
create_directories() {
    log_info "Creating necessary directories..."
    
    for dir in "$APP_DIR" "$LOG_DIR" "$BACKUP_DIR" "$BACKUP_DIR/database" "$BACKUP_DIR/code"; do
        if [ ! -d "$dir" ]; then
            mkdir -p "$dir"
            chmod 755 "$dir"
            log_info "Created directory: $dir"
        fi
    done
    
    log_success "Directories created"
}

# Backup current deployment
backup_current() {
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_path="$BACKUP_DIR/code/backup_$timestamp"
    
    log_info "Backing up current deployment..."
    
    if [ -d "$APP_DIR" ]; then
        cp -r "$APP_DIR" "$backup_path"
        log_success "Backup created at: $backup_path"
        
        # Remove old backups (keep last 5)
        ls -dt "$BACKUP_DIR/code/backup_"* | tail -n +6 | xargs rm -rf 2>/dev/null || true
    else
        log_warn "No existing deployment found to backup"
    fi
}

# Backup database
backup_database() {
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local backup_file="$BACKUP_DIR/database/backup_$timestamp.sql"
    
    log_info "Backing up database..."
    
    if [ -f "$ENV_FILE" ]; then
        source "$ENV_FILE"
        
        if pg_dump "$DATABASE_URL" > "$backup_file"; then
            log_success "Database backup created: $backup_file"
            
            # Compress backup
            gzip "$backup_file"
            log_info "Backup compressed: ${backup_file}.gz"
            
            # Remove old backups (keep last 7)
            ls -dt "$BACKUP_DIR/database/backup_"*.sql.gz | tail -n +8 | xargs rm -f 2>/dev/null || true
        else
            log_error "Failed to backup database"
            exit 1
        fi
    else
        log_warn "No .env file found, skipping database backup"
    fi
}

# Pull latest code
pull_latest_code() {
    log_info "Pulling latest code from $BRANCH branch..."
    
    if [ -d "$APP_DIR/.git" ]; then
        cd "$APP_DIR"
        git fetch origin
        git checkout "$BRANCH"
        git reset --hard origin/"$BRANCH"
    else
        rm -rf "$APP_DIR"
        git clone -b "$BRANCH" "$GIT_REPO" "$APP_DIR"
    fi
    
    log_success "Code updated to latest version"
}

# Install dependencies
install_dependencies() {
    log_info "Installing dependencies..."
    
    cd "$APP_DIR"
    
    # Remove existing node_modules for clean install
    if [ -d "node_modules" ]; then
        rm -rf node_modules
    fi
    
    npm ci --production
    log_success "Dependencies installed"
}

# Setup environment
setup_environment() {
    log_info "Setting up environment..."
    
    if [ ! -f "$ENV_FILE" ]; then
        log_warn "No .env file found, creating from template..."
        
        if [ -f ".env.example" ]; then
            cp ".env.example" "$ENV_FILE"
            log_warn "Please update $ENV_FILE with your actual configuration"
            log_warn "Deployment will continue but may fail without proper configuration"
        else
            log_error "No .env.example template found"
            exit 1
        fi
    fi
    
    # Ensure proper permissions
    chmod 600 "$ENV_FILE" 2>/dev/null || true
    
    log_success "Environment setup complete"
}

# Run database migrations
run_migrations() {
    log_info "Running database migrations..."
    
    cd "$APP_DIR"
    
    if [ -f "$ENV_FILE" ]; then
        source "$ENV_FILE"
        
        # Wait for database to be ready
        local max_attempts=30
        local attempt=1
        
        log_info "Waiting for database connection..."
        
        until psql "$DATABASE_URL" -c '\q' 2>/dev/null; do
            if [ $attempt -eq $max_attempts ]; then
                log_error "Database is not ready after $max_attempts attempts"
                exit 1
            fi
            
            log_info "Attempt $attempt/$max_attempts: Database not ready, waiting 2 seconds..."
            sleep 2
            attempt=$((attempt + 1))
        done
        
        # Run migrations
        if npm run db:migrate; then
            log_success "Database migrations completed"
        else
            log_error "Database migrations failed"
            exit 1
        fi
        
        # Run seeders if requested
        if [ "$SEED_DATABASE" = "true" ]; then
            log_info "Seeding database..."
            if npm run db:seed; then
                log_success "Database seeded"
            else
                log_error "Database seeding failed"
                exit 1
            fi
        fi
    else
        log_error "No .env file found, cannot run migrations"
        exit 1
    fi
}

# Build the application
build_application() {
    log_info "Building application..."
    
    cd "$APP_DIR"
    
    if [ -f "package.json" ] && grep -q "\"build\"" "package.json"; then
        if npm run build; then
            log_success "Application built successfully"
        else
            log_error "Build failed"
            exit 1
        fi
    else
        log_info "No build script found, skipping build step"
    fi
}

# Start/Restart the application
start_application() {
    log_info "Starting application..."
    
    cd "$APP_DIR"
    
    # Check if PM2 is already running this app
    if pm2 list | grep -q "$PM2_APP_NAME"; then
        log_info "Restarting existing PM2 application..."
        
        # Save current process list
        pm2 save
        
        # Restart the app
        if pm2 restart "$PM2_APP_NAME" --update-env; then
            log_success "Application restarted"
        else
            log_error "Failed to restart application"
            exit 1
        fi
    else
        log_info "Starting new PM2 application..."
        
        # Create ecosystem.config.js if it doesn't exist
        if [ ! -f "ecosystem.config.js" ]; then
            cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: '$PM2_APP_NAME',
    script: 'src/server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: '$LOG_DIR/err.log',
    out_file: '$LOG_DIR/out.log',
    log_file: '$LOG_DIR/combined.log',
    time: true,
    max_memory_restart: '1G',
    watch: false,
    merge_logs: true,
    kill_timeout: 5000,
    listen_timeout: 10000
  }]
};
EOF
        fi
        
        # Start the app
        if pm2 start ecosystem.config.js; then
            # Save PM2 process list
            pm2 save
            
            # Setup PM2 startup
            pm2 startup 2>/dev/null || true
            
            log_success "Application started"
        else
            log_error "Failed to start application"
            exit 1
        fi
    fi
    
    # Wait a bit for app to fully start
    sleep 5
    
    # Check if app is running
    if pm2 list | grep "$PM2_APP_NAME" | grep -q "online"; then
        log_success "Application is running and healthy"
    else
        log_error "Application failed to start properly"
        pm2 logs "$PM2_APP_NAME" --lines 20
        exit 1
    fi
}

# Run tests
run_tests() {
    log_info "Running tests..."
    
    cd "$APP_DIR"
    
    if [ -f "package.json" ] && grep -q "\"test\"" "package.json"; then
        if npm test; then
            log_success "Tests passed"
        else
            log_error "Tests failed"
            exit 1
        fi
    else
        log_info "No tests configured, skipping"
    fi
}

# Reload nginx (if applicable)
reload_nginx() {
    log_info "Reloading nginx configuration..."
    
    if systemctl is-active --quiet nginx; then
        if sudo nginx -t; then
            sudo systemctl reload nginx
            log_success "Nginx reloaded"
        else
            log_error "Nginx configuration test failed"
            exit 1
        fi
    else
        log_info "Nginx is not running, skipping reload"
    fi
}

# Show deployment summary
show_summary() {
    log_success "Deployment completed successfully!"
    log_info "Deployment Summary:"
    log_info "  Application: $APP_NAME"
    log_info "  Directory: $APP_DIR"
    log_info "  Environment: $NODE_ENV"
    log_info "  Branch: $BRANCH"
    log_info "  Timestamp: $(date '+%Y-%m-%d %H:%M:%S')"
    
    # Show application status
    log_info "  Application Status:"
    pm2 list | grep "$PM2_APP_NAME"
    
    # Show recent logs
    log_info "  Recent logs:"
    pm2 logs "$PM2_APP_NAME" --lines 5 --nostream
}

# Main deployment function
deploy() {
    log_info "Starting deployment of $APP_NAME..."
    
    # Run deployment steps
    check_root
    check_prerequisites
    create_directories
    backup_current
    backup_database
    pull_latest_code
    setup_environment
    install_dependencies
    build_application
    run_tests
    run_migrations
    start_application
    reload_nginx
    show_summary
    
    log_success "Deployment process completed!"
}

# Handle script arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --branch)
            BRANCH="$2"
            shift 2
            ;;
        --seed)
            SEED_DATABASE="true"
            shift
            ;;
        --skip-tests)
            SKIP_TESTS="true"
            shift
            ;;
        --skip-backup)
            SKIP_BACKUP="true"
            shift
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo "Options:"
            echo "  --branch <name>    Git branch to deploy (default: main)"
            echo "  --seed             Seed database after migrations"
            echo "  --skip-tests       Skip running tests"
            echo "  --skip-backup      Skip database and code backup"
            echo "  --help             Show this help message"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Override backup steps if --skip-backup is set
if [ "$SKIP_BACKUP" = "true" ]; then
    backup_current() {
        log_info "Skipping backup (--skip-backup flag set)"
    }
    
    backup_database() {
        log_info "Skipping database backup (--skip-backup flag set)"
    }
fi

# Override test step if --skip-tests is set
if [ "$SKIP_TESTS" = "true" ]; then
    run_tests() {
        log_info "Skipping tests (--skip-tests flag set)"
    }
fi

# Run deployment
deploy