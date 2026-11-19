import axios from "axios";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:4000",
  timeout: 10000,
});

const ACCESS_TOKEN_KEY = "tenantdrive.accessToken";
export const AUTH_EXPIRED_EVENT = "tenantdrive:auth-expired";

export type OrganizationRole = "ADMIN" | "MEMBER";
export type MembershipStatus = "ACTIVE" | "INVITED" | "SUSPENDED";

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
}

export interface AuthenticatedUser {
  id: string;
  name: string | null;
  email: string;
  organizations: OrganizationSummary[];
}

export interface OrganizationMember {
  userId: string;
  name: string | null;
  email: string;
  role: OrganizationRole;
  status: MembershipStatus;
  createdAt: string;
}

export interface MemberPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiResponse<T> {
  success: boolean;
  message?: string;
  data: T;
}

export interface HealthResponse {
  success: boolean;
  service: string;
  status: string;
  timestamp: string;
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setAccessToken(token: string | null): void {
  if (typeof window === "undefined") return;

  if (token) {
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
  } else {
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  }
}

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) config.headers.set("Authorization", `Bearer ${token}`);
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401 &&
      !error.config?.url?.includes("/api/auth/login")
    ) {
      setAccessToken(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
      }
    }

    return Promise.reject(error);
  }
);

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const responseData: unknown = error.response?.data;
    if (
      typeof responseData === "object" &&
      responseData !== null &&
      "message" in responseData &&
      typeof responseData.message === "string"
    ) {
      return responseData.message;
    }

    if (error.code === "ECONNABORTED") {
      return "The request timed out. Please try again.";
    }

    if (!error.response) {
      return "Unable to reach the TenantDrive API. Check your connection and try again.";
    }
  }

  return fallback;
}