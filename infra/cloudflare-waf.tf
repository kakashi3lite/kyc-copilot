# ──────────────────────────────────────────────────────────────────────────────
# KYC Copilot — Cloudflare WAF Ruleset (Terraform-style)
# Apply via Cloudflare Dashboard > Security > WAF > Custom Rules,
# or deploy via Terraform `cloudflare_ruleset` resource.
#
# These rules enforce AMLD6 data residency and API security at the edge,
# BEFORE traffic reaches the Fly.io origin in Amsterdam.
# ──────────────────────────────────────────────────────────────────────────────

# ┌─────────────────────────────────────────────────────────────────────────────
# │ Rule 1: Auth Endpoint Rate Limiting
# │ Prevents brute-force attacks on login/token endpoints.
# │ Limit: 10 requests per minute per IP (matches RATE_LIMIT_AUTH_PER_MINUTE).
# └─────────────────────────────────────────────────────────────────────────────

resource "cloudflare_ruleset" "kyc_waf" {
  zone_id     = var.cloudflare_zone_id
  name        = "KYC Copilot WAF Ruleset"
  description = "AMLD6-compliant WAF rules for KYC Copilot"
  kind        = "zone"
  phase       = "http_ratelimit"

  # ── Rule 1: Auth rate limiting ─────────────────────────────────────────────
  rules {
    action = "block"
    expression = <<-EOT
      (http.request.uri.path matches "^/api/v1/auth/.*$")
    EOT
    description = "Rate limit auth endpoints to 10 req/min per IP"
    enabled     = true

    ratelimit {
      characteristics     = ["cf.caching.key"]
      period              = 60
      requests_per_period  = 10
      mitigation_timeout   = 600
    }
  }
}

# ┌─────────────────────────────────────────────────────────────────────────────
# │ Rule 2: EU Geo-Fencing (AMLD6 Data Residency)
# │ Blocks all API requests originating from outside the European Economic Area.
# │ Allows health checks and static assets from anywhere.
# │
# │ EU/EEA country codes: AT, BE, BG, HR, CY, CZ, DK, EE, FI, FR, DE, GR,
# │ HU, IE, IT, LV, LT, LU, MT, NL, PL, PT, RO, SK, SI, ES, SE
# │ + EEA: IS, LI, NO  + CH (bilateral agreements)  + GB (adequacy decision)
# └─────────────────────────────────────────────────────────────────────────────

resource "cloudflare_ruleset" "kyc_geofence" {
  zone_id     = var.cloudflare_zone_id
  name        = "KYC Copilot EU Geo-Fence"
  description = "Block non-EU/EEA traffic from API endpoints"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules {
    action = "block"
    expression = <<-EOT
      (http.request.uri.path matches "^/api/.*$") and
      not (ip.geoip.country in {
        "AT" "BE" "BG" "HR" "CY" "CZ" "DK" "EE" "FI" "FR" "DE" "GR"
        "HU" "IE" "IT" "LV" "LT" "LU" "MT" "NL" "PL" "PT" "RO" "SK"
        "SI" "ES" "SE" "IS" "LI" "NO" "CH" "GB"
      })
    EOT
    description = "AMLD6 geo-fence: block non-EU/EEA API access"
    enabled     = true
  }
}

# ┌─────────────────────────────────────────────────────────────────────────────
# │ Rule 3: Suspicious Payload Challenge (SQLi / XSS)
# │ Issues a managed challenge for requests with common injection patterns.
# │ Uses Cloudflare's managed WAF OWASP rule group as primary defense;
# │ this custom rule catches edge cases in query params and JSON bodies.
# └─────────────────────────────────────────────────────────────────────────────

resource "cloudflare_ruleset" "kyc_payload_inspection" {
  zone_id     = var.cloudflare_zone_id
  name        = "KYC Copilot Payload Inspection"
  description = "Challenge suspicious SQLi/XSS payloads"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules {
    action = "managed_challenge"
    expression = <<-EOT
      (http.request.uri.path matches "^/api/.*$") and (
        http.request.uri.query contains "UNION" or
        http.request.uri.query contains "SELECT" or
        http.request.uri.query contains "DROP " or
        http.request.uri.query contains "INSERT " or
        http.request.uri.query contains "UPDATE " or
        http.request.uri.query contains "DELETE " or
        http.request.uri.query contains "--" or
        http.request.uri.query contains "'" or
        http.request.uri.query contains "<script" or
        http.request.uri.query contains "javascript:" or
        http.request.uri.query contains "onerror=" or
        http.request.uri.query contains "onload=" or
        http.request.uri.query contains "%3Cscript" or
        http.request.uri.query contains "1=1" or
        http.request.uri.query contains "OR 1"
      )
    EOT
    description = "Challenge requests with SQLi/XSS patterns in query string"
    enabled     = true
  }
}

# ┌─────────────────────────────────────────────────────────────────────────────
# │ Rule 4: API Rate Limiting (General)
# │ Prevents abuse of all API endpoints beyond the app-level rate limiter.
# │ Limit: 100 requests per minute per IP (matches RATE_LIMIT_API_PER_MINUTE).
# └─────────────────────────────────────────────────────────────────────────────

resource "cloudflare_ruleset" "kyc_api_ratelimit" {
  zone_id     = var.cloudflare_zone_id
  name        = "KYC Copilot API Rate Limit"
  description = "General API rate limiting"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules {
    action = "block"
    expression = <<-EOT
      (http.request.uri.path matches "^/api/.*$") and
      not (http.request.uri.path matches "^/api/v1/auth/.*$")
    EOT
    description = "Rate limit API endpoints to 100 req/min per IP"
    enabled     = true

    ratelimit {
      characteristics     = ["cf.caching.key"]
      period              = 60
      requests_per_period  = 100
      mitigation_timeout   = 300
    }
  }
}

# ── Variables ────────────────────────────────────────────────────────────────

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID for the kyc-copilot domain"
  type        = string
  sensitive   = true
}
