# 🔐 Secret Management Strategy

## 🏠 Local Development
**Current Setup (✅ Already Done)**
```bash
# Store in .env file (gitignored)
.env  # Your actual secrets here
```

## 🔧 CI/CD Pipelines (GitHub Actions)

### GitHub Repository Secrets
1. Go to: **Repository → Settings → Secrets and Variables → Actions**
2. Add secrets:
   - `GOOGLE_SHEETS_SPREADSHEET_ID`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `JIRA_BASE_URL`
   - `JIRA_EMAIL`
   - `JIRA_API_TOKEN`
   - `XRAY_CLIENT_ID`
   - `XRAY_CLIENT_SECRET`

### GitHub Actions Workflow Example
```yaml
name: Generate Reports
on:
  schedule:
    - cron: '0 9 * * *'  # Daily at 9 AM
jobs:
  generate-report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm install
      - run: node google-sheets-pivot-reporter-oauth-manual.js
        env:
          GOOGLE_SHEETS_SPREADSHEET_ID: ${{ secrets.GOOGLE_SHEETS_SPREADSHEET_ID }}
          GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          JIRA_BASE_URL: ${{ secrets.JIRA_BASE_URL }}
          JIRA_EMAIL: ${{ secrets.JIRA_EMAIL }}
          JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
```

## ☁️ Cloud Deployment Options

### AWS Deployment
```bash
# AWS Systems Manager Parameter Store
aws ssm put-parameter --name "/e2e-reports/jira-token" --value "your-token" --type "SecureString"

# AWS Secrets Manager  
aws secretsmanager create-secret --name "e2e-reports-secrets" --secret-string file://secrets.json
```

### Azure Deployment
```bash
# Azure Key Vault
az keyvault secret set --vault-name "E2EReportsVault" --name "JiraApiToken" --value "your-token"
```

### Google Cloud Deployment
```bash
# Google Secret Manager
gcloud secrets create jira-api-token --data-file=token.txt
```

### Heroku Deployment
```bash
# Heroku Config Vars
heroku config:set JIRA_API_TOKEN=your-token-here
heroku config:set GOOGLE_CLIENT_ID=your-client-id
```

## 🐳 Container Deployments

### Docker Secrets
```yaml
# docker-compose.yml
version: '3.8'
services:
  e2e-reports:
    image: your-app:latest
    secrets:
      - jira_token
      - google_credentials
    environment:
      - JIRA_API_TOKEN_FILE=/run/secrets/jira_token

secrets:
  jira_token:
    file: ./secrets/jira_token.txt
  google_credentials:
    file: ./secrets/google_creds.json
```

### Kubernetes Secrets
```yaml
# Create secret
kubectl create secret generic e2e-reports-secrets \
  --from-literal=jira-token='your-token' \
  --from-literal=google-client-id='your-client-id'

# Use in deployment
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: e2e-reports
        env:
        - name: JIRA_API_TOKEN
          valueFrom:
            secretKeyRef:
              name: e2e-reports-secrets
              key: jira-token
```

## 🏢 Enterprise Solutions

### HashiCorp Vault
```bash
# Store secrets
vault kv put secret/e2e-reports \
  jira_token="your-token" \
  google_client_id="your-client-id"

# Retrieve in application
vault kv get -field=jira_token secret/e2e-reports
```

### New Relic Infrastructure (Recommended for you)
```bash
# New Relic Synthetics Secure Credentials
# Store in: New Relic → Synthetics → Secure credentials
# Access via: $secure.JIRA_API_TOKEN
```

## 📋 Current Recommendations for You

### 1. **GitHub Actions** (Immediate Next Step)
- Store secrets in GitHub repository settings
- Set up automated daily report generation

### 2. **New Relic Infrastructure** (Enterprise)
- Use New Relic's secure credential management
- Leverage existing New Relic infrastructure

### 3. **Production Deployment**
- AWS Systems Manager Parameter Store (if using AWS)
- Azure Key Vault (if using Azure)
- Google Secret Manager (if using GCP)

Would you like me to help set up any specific environment?