/**
 * Who is signed in, shared across the app.
 *
 * The token lives in localStorage so a farmer stays signed in between visits;
 * the decoded role decides which screens they get.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { tokenStore } from "./api";
import type { FarmerProfile, LoginResponse, Role, UnitContext } from "./types";

interface AuthState {
  role: Role | null;
  farmer: FarmerProfile | null;
  /** Present only for a unit head: which unit they oversee. */
  unit: UnitContext | null;
  signIn: (login: LoginResponse) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** Read the role out of a JWT without verifying it.
 *
 * Verification is the server's job on every request; here we only need to know
 * which screen to render, and a tampered token simply fails at the API. */
function readToken(token: string): { role: Role } | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.exp * 1000 < Date.now()) return null;
    return { role: payload.role };
  } catch {
    return null;
  }
}

const PROFILE_KEY = "crop-analytics.profile";
const UNIT_KEY = "crop-analytics.unit";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<Role | null>(null);
  const [farmer, setFarmer] = useState<FarmerProfile | null>(null);
  const [unit, setUnit] = useState<UnitContext | null>(null);

  // Restore an existing session on first load.
  useEffect(() => {
    const token = tokenStore.get();
    const claims = token ? readToken(token) : null;
    if (!claims) {
      tokenStore.clear();
      return;
    }
    setRole(claims.role);
    const stored = localStorage.getItem(PROFILE_KEY);
    if (stored) setFarmer(JSON.parse(stored));
    const storedUnit = localStorage.getItem(UNIT_KEY);
    if (storedUnit) setUnit(JSON.parse(storedUnit));
  }, []);

  const signIn = useCallback((login: LoginResponse) => {
    tokenStore.set(login.token);
    setRole(login.role);
    setFarmer(login.farmer);
    setUnit(login.unit);
    if (login.farmer) {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(login.farmer));
    }
    if (login.unit) {
      localStorage.setItem(UNIT_KEY, JSON.stringify(login.unit));
    }
  }, []);

  const signOut = useCallback(() => {
    tokenStore.clear();
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(UNIT_KEY);
    setRole(null);
    setFarmer(null);
    setUnit(null);
  }, []);

  const value = useMemo(
    () => ({ role, farmer, unit, signIn, signOut }),
    [role, farmer, unit, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}
