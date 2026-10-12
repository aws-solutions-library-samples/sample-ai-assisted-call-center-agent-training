/**
 * API client for the Connect admin API Gateway.
 * Uses Cognito ID tokens (JWT) for authentication.
 */

import { fetchAuthSession } from 'aws-amplify/auth';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error('Not authenticated - no ID token available');
  }
  return idToken;
}

/**
 * Make an authenticated API request to the Connect admin API Gateway.
 */
export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
  } = {}
): Promise<T> {
  const { method = 'GET', body } = options;

  if (!API_BASE_URL) {
    throw new Error('API URL not configured. Set VITE_API_URL environment variable.');
  }

  const token = await getIdToken();

  const base = API_BASE_URL.replace(/\/$/, '');
  const fullPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${base}${fullPath}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `API request failed: ${response.status}`);
  }

  return response.json();
}

