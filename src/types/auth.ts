export type UserRole = 'admin' | 'conferente' | 'operador';

export interface AppUser {
  id: string;
  username: string;
  fullName: string;
  email?: string;
  googleUid?: string;
  role: UserRole;
  sector: string;
  active: boolean;
  passwordHash: string;
  passwordSalt: string;
  mustChangePassword?: boolean;
  passwordResetRequested?: boolean;
  passwordResetRequestedAt?: string;
  createdAt: string;
  createdBy: string;
  lastLoginAt?: string;
}

export type PublicUser = Omit<AppUser, 'passwordHash' | 'passwordSalt'>;

export interface RegisterUserInput {
  username: string;
  fullName: string;
  email?: string;
  password: string;
  role: UserRole;
  sector: string;
  mustChangePassword?: boolean;
  createdBy?: string;
}

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrador',
  conferente: 'Conferente',
  operador: 'Operador',
};

export const DEFAULT_SECTORS = [
  'Estoque Central',
  'Conferência',
  'Faturamento',
  'Logística',
  'Gerência',
] as const;
