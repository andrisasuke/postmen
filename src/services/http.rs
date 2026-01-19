use crate::models::{HttpResponse, HttpMethod, FormDataField, FormFieldType};
use std::collections::HashMap;
use std::time::Instant;
use reqwest::multipart;

pub struct HttpService;

fn format_reqwest_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "Request timeout: The server took too long to respond".to_string();
    }
    if e.is_connect() {
        return format!("Connection failed: Unable to connect to the server\n\n{}", e);
    }
    if e.is_request() {
        return format!("Request error: Failed to send request\n\n{}", e);
    }
    if e.is_body() {
        return format!("Body error: Failed to read request body\n\n{}", e);
    }
    if e.is_decode() {
        return format!("Decode error: Failed to decode response\n\n{}", e);
    }
    if e.is_redirect() {
        return format!("Redirect error: Too many redirects\n\n{}", e);
    }
    if e.is_status() {
        if let Some(status) = e.status() {
            return format!("HTTP error: {} {}", status.as_u16(), status.canonical_reason().unwrap_or("Unknown"));
        }
    }
    // Check for common error patterns in the error message
    let error_str = e.to_string();
    if error_str.contains("dns error") || error_str.contains("failed to lookup") {
        return format!("DNS error: Could not resolve hostname\n\n{}", e);
    }
    if error_str.contains("connection refused") {
        return format!("Connection refused: Server is not accepting connections\n\n{}", e);
    }
    if error_str.contains("connection reset") {
        return format!("Connection reset: Server closed the connection\n\n{}", e);
    }

    format!("Request failed: {}", e)
}

impl HttpService {
    pub async fn send_request(
        method: HttpMethod,
        url: &str,
        headers: &[(String, String)],
        body: Option<&str>,
    ) -> Result<HttpResponse, String> {
        // Debug logging
        println!("\n{}", "=".repeat(60));
        println!("[REQUEST] {} {}", method, url);
        println!("{}", "-".repeat(60));

        println!("[REQUEST HEADERS]");
        if headers.is_empty() {
            println!("  (none)");
        } else {
            for (key, value) in headers {
                println!("  {}: {}", key, value);
            }
        }

        println!("[REQUEST BODY]");
        if let Some(body_content) = body {
            if !body_content.is_empty() {
                // Pretty print JSON if possible
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(body_content) {
                    if let Ok(pretty) = serde_json::to_string_pretty(&json) {
                        println!("{}", pretty);
                    } else {
                        println!("{}", body_content);
                    }
                } else {
                    println!("{}", body_content);
                }
            } else {
                println!("  (empty)");
            }
        } else {
            println!("  (none)");
        }
        println!("{}", "=".repeat(60));

        let client = reqwest::Client::new();
        let start = Instant::now();

        let mut request_builder = match method {
            HttpMethod::GET => client.get(url),
            HttpMethod::POST => client.post(url),
            HttpMethod::PUT => client.put(url),
            HttpMethod::DELETE => client.delete(url),
            HttpMethod::OPTIONS => client.request(reqwest::Method::OPTIONS, url),
        };

        // Add headers
        for (key, value) in headers {
            request_builder = request_builder.header(key, value);
        }

        // Add body for POST/PUT and auto-add Content-Type: application/json if body is JSON
        if let Some(body_content) = body {
            if !body_content.is_empty() {
                // Check if body is valid JSON and Content-Type not already set
                let has_content_type = headers.iter().any(|(k, _)| k.to_lowercase() == "content-type");
                if !has_content_type && serde_json::from_str::<serde_json::Value>(body_content).is_ok() {
                    request_builder = request_builder.header("Content-Type", "application/json");
                    println!("[AUTO-ADDED] Content-Type: application/json");
                }
                request_builder = request_builder.body(body_content.to_string());
            }
        }

        let response = request_builder
            .send()
            .await
            .map_err(|e| format_reqwest_error(&e))?;

        let elapsed = start.elapsed();
        let status = response.status().as_u16();
        let status_text = response.status().canonical_reason().unwrap_or("Unknown").to_string();

        // Get response headers
        let mut response_headers = HashMap::new();
        for (key, value) in response.headers() {
            if let Ok(v) = value.to_str() {
                response_headers.insert(key.to_string(), v.to_string());
            }
        }

        let body = response.text().await.map_err(|e| format_reqwest_error(&e))?;
        let size_bytes = body.len();

        // Debug response logging
        println!("\n{}", "=".repeat(60));
        println!("[RESPONSE] {} {} ({}ms, {} bytes)", status, status_text, elapsed.as_millis(), size_bytes);
        println!("{}", "-".repeat(60));

        if !response_headers.is_empty() {
            println!("[RESPONSE HEADERS]");
            for (key, value) in &response_headers {
                println!("  {}: {}", key, value);
            }
        }

        println!("[RESPONSE BODY]");
        // Pretty print JSON if possible, truncate if too long
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Ok(pretty) = serde_json::to_string_pretty(&json) {
                if pretty.len() > 2000 {
                    println!("{}...\n[truncated, {} total chars]", &pretty[..2000], pretty.len());
                } else {
                    println!("{}", pretty);
                }
            } else {
                println!("{}", if body.len() > 2000 { format!("{}...", &body[..2000]) } else { body.clone() });
            }
        } else {
            println!("{}", if body.len() > 2000 { format!("{}...", &body[..2000]) } else { body.clone() });
        }
        println!("{}", "=".repeat(60));

        Ok(HttpResponse {
            status,
            status_text,
            time_ms: elapsed.as_millis() as u64,
            size_bytes,
            headers: response_headers,
            body,
        })
    }

    pub async fn send_multipart_request(
        method: HttpMethod,
        url: &str,
        headers: &[(String, String)],
        form_data: &[FormDataField],
    ) -> Result<HttpResponse, String> {
        // Debug logging
        println!("\n{}", "=".repeat(60));
        println!("[MULTIPART REQUEST] {} {}", method, url);
        println!("{}", "-".repeat(60));

        println!("[REQUEST HEADERS]");
        if headers.is_empty() {
            println!("  (none)");
        } else {
            for (key, value) in headers {
                println!("  {}: {}", key, value);
            }
        }

        println!("[FORM DATA]");
        for field in form_data {
            if !field.enabled {
                continue;
            }
            match field.field_type {
                FormFieldType::Text => {
                    println!("  {} = {} (text)", field.key, field.value);
                }
                FormFieldType::File => {
                    println!("  {} = {} (file)", field.key, field.value);
                }
            }
        }
        println!("{}", "=".repeat(60));

        let client = reqwest::Client::new();
        let start = Instant::now();

        // Build multipart form
        let mut form = multipart::Form::new();
        for field in form_data {
            if !field.enabled || field.key.is_empty() {
                continue;
            }
            match field.field_type {
                FormFieldType::Text => {
                    form = form.text(field.key.clone(), field.value.clone());
                }
                FormFieldType::File => {
                    if !field.value.is_empty() {
                        // Read file from disk
                        let file_path = std::path::Path::new(&field.value);
                        let file_name = file_path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("file")
                            .to_string();

                        match tokio::fs::read(&field.value).await {
                            Ok(file_bytes) => {
                                let part = multipart::Part::bytes(file_bytes)
                                    .file_name(file_name);
                                form = form.part(field.key.clone(), part);
                            }
                            Err(e) => {
                                return Err(format!("Failed to read file '{}': {}", field.value, e));
                            }
                        }
                    }
                }
            }
        }

        let mut request_builder = match method {
            HttpMethod::GET => client.get(url),
            HttpMethod::POST => client.post(url),
            HttpMethod::PUT => client.put(url),
            HttpMethod::DELETE => client.delete(url),
            HttpMethod::OPTIONS => client.request(reqwest::Method::OPTIONS, url),
        };

        // Add custom headers (but not Content-Type, as multipart sets it automatically)
        for (key, value) in headers {
            if key.to_lowercase() != "content-type" {
                request_builder = request_builder.header(key, value);
            }
        }

        // Set the multipart form
        request_builder = request_builder.multipart(form);

        let response = request_builder
            .send()
            .await
            .map_err(|e| format_reqwest_error(&e))?;

        let elapsed = start.elapsed();
        let status = response.status().as_u16();
        let status_text = response.status().canonical_reason().unwrap_or("Unknown").to_string();

        // Get response headers
        let mut response_headers = HashMap::new();
        for (key, value) in response.headers() {
            if let Ok(v) = value.to_str() {
                response_headers.insert(key.to_string(), v.to_string());
            }
        }

        let body = response.text().await.map_err(|e| format_reqwest_error(&e))?;
        let size_bytes = body.len();

        // Debug response logging
        println!("\n{}", "=".repeat(60));
        println!("[RESPONSE] {} {} ({}ms, {} bytes)", status, status_text, elapsed.as_millis(), size_bytes);
        println!("{}", "-".repeat(60));

        if !response_headers.is_empty() {
            println!("[RESPONSE HEADERS]");
            for (key, value) in &response_headers {
                println!("  {}: {}", key, value);
            }
        }

        println!("[RESPONSE BODY]");
        // Pretty print JSON if possible, truncate if too long
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Ok(pretty) = serde_json::to_string_pretty(&json) {
                if pretty.len() > 2000 {
                    println!("{}...\n[truncated, {} total chars]", &pretty[..2000], pretty.len());
                } else {
                    println!("{}", pretty);
                }
            } else {
                println!("{}", if body.len() > 2000 { format!("{}...", &body[..2000]) } else { body.clone() });
            }
        } else {
            println!("{}", if body.len() > 2000 { format!("{}...", &body[..2000]) } else { body.clone() });
        }
        println!("{}", "=".repeat(60));

        Ok(HttpResponse {
            status,
            status_text,
            time_ms: elapsed.as_millis() as u64,
            size_bytes,
            headers: response_headers,
            body,
        })
    }

    pub fn format_json(json_str: &str) -> Result<String, String> {
        let value: serde_json::Value = serde_json::from_str(json_str)
            .map_err(|e| {
                format!("{} at line {} column {}",
                    e.to_string().split(" at line").next().unwrap_or(&e.to_string()),
                    e.line(),
                    e.column()
                )
            })?;
        serde_json::to_string_pretty(&value)
            .map_err(|e| e.to_string())
    }

    pub fn format_json_with_line(json_str: &str) -> Result<String, (String, usize)> {
        let line_count = json_str.lines().count().max(1);
        let value: serde_json::Value = serde_json::from_str(json_str)
            .map_err(|e| {
                let error_line = e.line();
                // If error is at EOF or beyond content, point to last line
                let actual_line = if error_line > line_count || error_line == 0 {
                    line_count
                } else {
                    error_line
                };
                let msg = format!("{} at line {} column {}",
                    e.to_string().split(" at line").next().unwrap_or(&e.to_string()),
                    actual_line,
                    e.column()
                );
                (msg, actual_line)
            })?;
        serde_json::to_string_pretty(&value)
            .map_err(|e| (e.to_string(), 1))
    }
}
