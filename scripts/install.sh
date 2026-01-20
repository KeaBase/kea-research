#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}KEA Research Installer${NC}"
echo -e "${CYAN}═══════════════════════════════════════${NC}"
echo ""

# Detect OS
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
    elif [ "$(uname)" = "Darwin" ]; then
        OS="macos"
    else
        OS="unknown"
    fi
    echo "$OS"
}

# Install git based on OS 
install_git() {
    local os=$(detect_os)
    echo -e "${YELLOW}Installing git...${NC}"


    case "$os" in
        ubuntu|debian|raspbian)
            sudo apt-get update && sudo apt-get install -y git
            ;;
        centos|rhel|rocky|almalinux)
            if command -v dnf >/dev/null 2>&1; then
                sudo dnf install -y git
            else
                sudo yum install -y git
            fi
            ;;
        fedora)
            sudo dnf install -y git
            ;;
        macos)
            echo -e "${YELLOW}Installing Xcode Command Line Tools (includes git)...${NC}"
            xcode-select --install 2>/dev/null || true
            echo -e "${YELLOW}Please complete the installation dialog, then run this script again.${NC}"
            exit 0
            ;;
        *)
            echo -e "${RED}Error: Could not detect OS. Please install git manually.${NC}"
            exit 1
            ;;
    esac
}

# Checkout latest version tag
# Returns 0 if checkout performed, 1 if already on latest
checkout_latest_version() {
    echo -e "${YELLOW}Fetching latest version...${NC}"
    git fetch --tags
    LATEST_TAG=$(git ls-remote --tags origin | grep -o "v[0-9]*\.[0-9]*\.[0-9]*$" | sort -V | tail -n 1)
    
    if [ -z "$LATEST_TAG" ]; then
        echo -e "${YELLOW}No version tags found, staying on current branch${NC}"
        return 0
    fi
    
    # Get current tag (if on a tag) or branch name
    CURRENT_TAG=$(git describe --tags --exact-match 2>/dev/null || echo "")
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    
    if [ "$CURRENT_TAG" = "$LATEST_TAG" ]; then
        echo -e "${GREEN}Already on latest version ($LATEST_TAG)${NC}"
        return 1
    fi
    
    if [ -n "$CURRENT_TAG" ]; then
        echo -e "${YELLOW}Updating from $CURRENT_TAG to $LATEST_TAG${NC}"
    elif [ "$CURRENT_BRANCH" = "main" ]; then
        echo -e "${YELLOW}Switching from main branch to $LATEST_TAG${NC}"
    else
        echo -e "${YELLOW}Checking out version $LATEST_TAG${NC}"
    fi
    
    git checkout "$LATEST_TAG"
    return 0
}

# Check for git
if ! command -v git >/dev/null 2>&1; then
    echo -e "${YELLOW}Git is not installed.${NC}"
    read -p "Install git now? (Y/n): " INSTALL_GIT
    if [[ ! "$INSTALL_GIT" =~ ^[Nn] ]]; then
        install_git
    else
        echo -e "${RED}Error: git is required. Please install it manually.${NC}"
        exit 1
    fi
fi

# Check for docker (manual install required)
command -v docker >/dev/null 2>&1 || { echo -e "${RED}Error: docker is required but not installed.${NC}"; echo -e "Install Docker: https://docs.docker.com/engine/install/"; exit 1; }

# Check installation state
if [ -d "kea-research" ]; then
    if [ -f "kea-research/.env" ]; then
        # Folder + .env = Update mode
        echo -e "${YELLOW}Existing installation found. Checking for updates...${NC}"
        cd kea-research
        if checkout_latest_version; then
            echo ""
            echo -e "${YELLOW}Rebuilding containers...${NC}"
            if command -v docker compose >/dev/null 2>&1; then
                docker compose up -d --build
            else
                docker-compose up -d --build
            fi
            echo ""
            echo -e "${GREEN}${BOLD}════════════════════════════════════════════${NC}"
            echo -e "${GREEN}${BOLD}  KEA Research updated successfully!${NC}"
            echo -e "${GREEN}${BOLD}════════════════════════════════════════════${NC}"
            echo ""
        else
            echo ""
            echo -e "${GREEN}${BOLD}════════════════════════════════════════════${NC}"
            echo -e "${GREEN}${BOLD}  No updates available.${NC}"
            echo -e "${GREEN}${BOLD}════════════════════════════════════════════${NC}"
            echo ""
        fi
        exit 0
    else
        # Folder but no .env = Incomplete install, continue setup
        echo -e "${YELLOW}Incomplete installation found. Continuing setup...${NC}"
        cd kea-research
        checkout_latest_version
    fi
else
    # No folder = Fresh install
    echo -e "${YELLOW}Cloning repository...${NC}"
    git clone https://github.com/keabase/kea-research.git
    cd kea-research
    checkout_latest_version
fi

# Copy environment file
cp .env.example .env

# Generate random 12-char admin password
ADMIN_PASSWORD=$(LC_ALL=C head -c 500 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 12)

echo ""
echo -e "${CYAN}${BOLD}API Keys Configuration${NC}"
echo -e "${CYAN}Press Enter to skip any key. You can add keys later in Admin Panel.${NC}"
echo ""
echo -e "  Get keys: ${BOLD}console.anthropic.com${NC} | ${BOLD}platform.openai.com${NC}"
echo -e "            ${BOLD}aistudio.google.com${NC} | ${BOLD}console.mistral.ai${NC} | ${BOLD}console.x.ai${NC}"
echo -e "            ${BOLD}openrouter.ai${NC}"
echo ""

# Prompt for API keys (default to "x" if empty to ensure providers are created)
read -p "ANTHROPIC_API_KEY: " ANTHROPIC_KEY
read -p "OPENAI_API_KEY: " OPENAI_KEY
read -p "GOOGLE_API_KEY: " GOOGLE_KEY
read -p "MISTRAL_API_KEY: " MISTRAL_KEY
read -p "XAI_API_KEY: " XAI_KEY
read -p "OPENROUTER_API_KEY: " OPENROUTER_KEY

[ -z "$ANTHROPIC_KEY" ] && ANTHROPIC_KEY="x"
[ -z "$OPENAI_KEY" ] && OPENAI_KEY="x"
[ -z "$GOOGLE_KEY" ] && GOOGLE_KEY="x"
[ -z "$MISTRAL_KEY" ] && MISTRAL_KEY="x"
[ -z "$XAI_KEY" ] && XAI_KEY="x"
[ -z "$OPENROUTER_KEY" ] && OPENROUTER_KEY="x"

echo ""
echo -e "${CYAN}${BOLD}Domain Configuration${NC}"
echo -e "  ${CYAN}localhost = local access only (this computer)${NC}"
echo -e "  ${CYAN}domain    = public access via your domain (e.g. research.keabase.dev)${NC}"
echo ""
read -p "Enter domain (or press Enter for localhost): " DOMAIN

USE_OWN_CERT="false"

if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "localhost" ]; then
    # SSL Certificate options
    echo ""
    echo -e "${CYAN}${BOLD}SSL Certificate${NC}"
    echo "  1) Let's Encrypt (automatic, recommended)"
    echo "  2) Own certificate"
    echo ""
    read -p "Choose option (1/2) [1]: " SSL_OPTION

    if [ "$SSL_OPTION" = "2" ]; then
        USE_OWN_CERT="true"
        echo ""
        echo -e "${YELLOW}Please place your certificate files:${NC}"
        echo -e "  ${BOLD}nginx/ssl/fullchain.crt${NC} - Your certificate chain"
        echo -e "  ${BOLD}nginx/ssl/private.key${NC}  - Your private key"
        echo ""
        mkdir -p nginx/ssl
        read -p "Press Enter when files are in place..."

        if [ ! -f "nginx/ssl/fullchain.crt" ] || [ ! -f "nginx/ssl/private.key" ]; then
            echo -e "${YELLOW}Warning: Certificate files not found. Continuing anyway...${NC}"
        fi
    fi
else
    DOMAIN="localhost"
fi

# Update .env file
echo ""
echo -e "${YELLOW}Configuring environment...${NC}"

sed -i.bak "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PASSWORD|" .env
sed -i.bak "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" .env

[ -n "$ANTHROPIC_KEY" ] && sed -i.bak "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$ANTHROPIC_KEY|" .env
[ -n "$OPENAI_KEY" ] && sed -i.bak "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$OPENAI_KEY|" .env
[ -n "$GOOGLE_KEY" ] && sed -i.bak "s|^GOOGLE_API_KEY=.*|GOOGLE_API_KEY=$GOOGLE_KEY|" .env
[ -n "$MISTRAL_KEY" ] && sed -i.bak "s|^MISTRAL_API_KEY=.*|MISTRAL_API_KEY=$MISTRAL_KEY|" .env
[ -n "$XAI_KEY" ] && sed -i.bak "s|^XAI_API_KEY=.*|XAI_API_KEY=$XAI_KEY|" .env
[ -n "$OPENROUTER_KEY" ] && sed -i.bak "s|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=$OPENROUTER_KEY|" .env

# Add USE_OWN_CERT if using own cert
if [ "$USE_OWN_CERT" = "true" ]; then
    if grep -q "^USE_OWN_CERT=" .env; then
        sed -i.bak "s|^USE_OWN_CERT=.*|USE_OWN_CERT=true|" .env
    else
        echo "USE_OWN_CERT=true" >> .env
    fi
fi

rm -f .env.bak

# Start the application
echo ""
echo -e "${YELLOW}Starting KEA Research...${NC}"
if command -v docker compose >/dev/null 2>&1; then
    docker compose up -d
else
    docker-compose up -d
fi

echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  KEA Research installed successfully!${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════${NC}"
echo ""
echo -e "  Admin Password: ${BOLD}${YELLOW}$ADMIN_PASSWORD${NC}"
echo -e "  ${CYAN}(saved in .env file)${NC}"
echo ""
if [ "$DOMAIN" = "localhost" ]; then
    echo -e "  Access: ${BOLD}http://localhost${NC}"
else
    echo -e "  Access: ${BOLD}https://$DOMAIN${NC}"
fi
echo ""
