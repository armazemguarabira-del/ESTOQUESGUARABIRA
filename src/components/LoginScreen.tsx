import React, { useState } from 'react';
import {
  Eye,
  EyeOff,
  Lock,
  User as UserIcon,
  LogIn,
  AlertCircle,
  CheckCircle2,
  PackageCheck,
  ArrowLeft,
  KeyRound,
  ShieldCheck,
} from 'lucide-react';
import { PublicUser } from '../types/auth';
import {
  authenticateUserInFirestore,
  signInWithGoogleInFirestore,
  requestPasswordResetInFirestore,
  resetPasswordWithGoogleInFirestore,
} from '../firebase';

interface LoginScreenProps {
  onLoginSuccess: (user: PublicUser) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const [viewMode, setViewMode] = useState<'login' | 'forgot'>('login');

  // Login form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Forgot password state
  const [forgotUsername, setForgotUsername] = useState('');
  const [forgotStep, setForgotStep] = useState<'identify' | 'google_reset' | 'requested'>('identify');
  const [maskedEmail, setMaskedEmail] = useState<string | undefined>(undefined);
  const [hasLinkedEmail, setHasLinkedEmail] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!username.trim() || !password) {
      setErrorMessage('Informe seu usuário e sua senha para entrar.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await authenticateUserInFirestore(username, password);
      if (res.success && res.user) {
        onLoginSuccess(res.user);
      } else {
        setErrorMessage(res.error || 'Usuário ou senha inválidos.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleLogin = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setGoogleSubmitting(true);
    try {
      const res = await signInWithGoogleInFirestore();
      if (res.success && res.user) {
        onLoginSuccess(res.user);
      } else {
        setErrorMessage(res.error || 'Não foi possível entrar com o Google.');
      }
    } finally {
      setGoogleSubmitting(false);
    }
  };

  const openForgotView = () => {
    setViewMode('forgot');
    setForgotUsername(username);
    setForgotStep('identify');
    setMaskedEmail(undefined);
    setHasLinkedEmail(false);
    setNewPassword('');
    setConfirmNewPassword('');
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const backToLogin = () => {
    setViewMode('login');
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!forgotUsername.trim()) {
      setErrorMessage('Informe seu nome de usuário.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await requestPasswordResetInFirestore(forgotUsername);
      if (res.success) {
        setHasLinkedEmail(Boolean(res.hasLinkedEmail));
        setMaskedEmail(res.maskedEmail);
        if (res.hasLinkedEmail) {
          setForgotStep('google_reset');
          setSuccessMessage(
            `Solicitação registrada. Você pode redefinir imediatamente validando a conta Google (${res.maskedEmail}) ou aguardar uma senha provisória do administrador.`
          );
        } else {
          setForgotStep('requested');
          setSuccessMessage(
            'Solicitação de redefinição enviada! Procure um administrador para receber sua senha provisória na guia Cadastro de Usuários.'
          );
        }
      } else {
        setErrorMessage(res.error || 'Não foi possível localizar o usuário.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleGooglePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (newPassword.length < 4) {
      setErrorMessage('A nova senha deve ter pelo menos 4 caracteres.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setErrorMessage('As senhas digitadas não conferem.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await resetPasswordWithGoogleInFirestore(forgotUsername, newPassword);
      if (res.success && res.user) {
        onLoginSuccess(res.user);
      } else {
        setErrorMessage(res.error || 'Falha ao redefinir a senha via Google.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting || googleSubmitting;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col">
      <div className="top-black-bar" />
      <div className="h-1.5 bg-[#FFC000] w-full" />

      <div className="flex-1 flex items-center justify-center p-4 sm:p-8 lg:p-12">
        <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden grid grid-cols-1 lg:grid-cols-12 items-stretch">
          {/* Painel Institucional Esquerdo */}
          <div className="lg:col-span-5 bg-slate-900 text-white p-8 sm:p-10 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-3 mb-8">
                <div className="w-10 h-10 rounded-lg bg-[#FFC000] text-slate-950 flex items-center justify-center shrink-0">
                  <PackageCheck className="w-5 h-5" />
                </div>
                <div>
                  <h1 className="text-lg font-bold tracking-tight text-white leading-snug">
                    Estoque Oficial Guarabira
                  </h1>
                  <p className="text-xs text-slate-400">
                    Controle e Conciliação de Inventário
                  </p>
                </div>
              </div>

              <h2
                className="text-2xl font-bold tracking-tight text-white leading-tight mb-4"
                style={{ textWrap: 'balance' }}
              >
                Acesso restrito à equipe autorizada
              </h2>
              <p className="text-sm text-slate-300 leading-relaxed mb-8">
                Entre com seu usuário e senha ou utilize sua conta Google corporativa para acessar o painel de divergências, estoque central e grade.
              </p>

              <div className="space-y-4 border-t border-slate-800 pt-6 text-xs text-slate-300">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="w-4 h-4 text-[#FFC000] shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-white">Cadastro centralizado</p>
                    <p className="text-slate-400 mt-0.5">
                      Novos usuários são cadastrados internamente pela guia Cadastro de Usuários após o login.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-10 pt-5 border-t border-slate-800 text-xs text-slate-400">
              <span>Unidade Guarabira</span>
              <span aria-hidden="true"> · </span>
              <span>Sincronização em tempo real</span>
            </div>
          </div>

          {/* Painel Direito: Somente Login / Google / Esqueceu a Senha */}
          <div className="lg:col-span-7 p-6 sm:p-10 flex flex-col justify-center bg-white">
            {viewMode === 'login' ? (
              <div className="space-y-6">
                <div>
                  <h3 className="text-xl font-bold text-slate-900">Entrar na plataforma</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Informe seu usuário e senha ou acesse com sua conta Google.
                  </p>
                </div>

                {errorMessage && (
                  <div
                    role="alert"
                    className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2.5"
                  >
                    <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                {successMessage && (
                  <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>{successMessage}</span>
                  </div>
                )}

                <form onSubmit={handleLoginSubmit} className="space-y-4">
                  <div>
                    <label
                      htmlFor="login-username"
                      className="block text-xs font-semibold text-slate-700 mb-1.5"
                    >
                      Usuário
                    </label>
                    <div className="relative">
                      <UserIcon className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="login-username"
                        type="text"
                        autoComplete="username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Digite seu usuário"
                        className="w-full pl-10 pr-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
                        disabled={busy}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label
                        htmlFor="login-password"
                        className="block text-xs font-semibold text-slate-700"
                      >
                        Senha
                      </label>
                      <button
                        type="button"
                        onClick={openForgotView}
                        className="text-xs font-semibold text-slate-700 hover:text-slate-950 underline underline-offset-2 cursor-pointer"
                        disabled={busy}
                      >
                        Esqueceu a senha?
                      </button>
                    </div>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        id="login-password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Digite sua senha"
                        className="w-full pl-10 pr-11 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
                        disabled={busy}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((prev) => !prev)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
                        aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full py-2.5 px-5 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-[#FFC000] font-bold text-sm rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>{submitting ? 'Entrando...' : 'Entrar no Sistema'}</span>
                  </button>
                </form>

                <div className="relative flex items-center">
                  <div className="flex-grow border-t border-slate-200" />
                  <span className="px-3 text-xs text-slate-400 font-medium">ou</span>
                  <div className="flex-grow border-t border-slate-200" />
                </div>

                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  disabled={busy}
                  className="w-full py-2.5 px-5 bg-white hover:bg-slate-50 disabled:opacity-60 text-slate-800 font-semibold text-sm border border-slate-300 rounded-lg transition-colors flex items-center justify-center gap-2.5 cursor-pointer"
                >
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
                    />
                  </svg>
                  <span>{googleSubmitting ? 'Conectando ao Google...' : 'Entrar com o Google'}</span>
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={backToLogin}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                    disabled={busy}
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Voltar para o login</span>
                  </button>
                </div>

                <div>
                  <h3 className="text-xl font-bold text-slate-900">Esqueceu a senha?</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Informe seu usuário para redefinir a senha via Google ou solicitar uma senha provisória ao administrador.
                  </p>
                </div>

                {errorMessage && (
                  <div
                    role="alert"
                    className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2.5"
                  >
                    <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                {successMessage && (
                  <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <span>{successMessage}</span>
                  </div>
                )}

                {forgotStep === 'identify' && (
                  <form onSubmit={handleRequestReset} className="space-y-4">
                    <div>
                      <label
                        htmlFor="forgot-username"
                        className="block text-xs font-semibold text-slate-700 mb-1.5"
                      >
                        Usuário cadastrado
                      </label>
                      <div className="relative">
                        <UserIcon className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          id="forgot-username"
                          type="text"
                          value={forgotUsername}
                          onChange={(e) => setForgotUsername(e.target.value)}
                          placeholder="Ex: admin ou joao.silva"
                          className="w-full pl-10 pr-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
                          disabled={busy}
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={busy}
                      className="w-full py-2.5 px-5 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-[#FFC000] font-bold text-sm rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <KeyRound className="w-4 h-4" />
                      <span>{submitting ? 'Verificando...' : 'Continuar Recuperação'}</span>
                    </button>
                  </form>
                )}

                {forgotStep === 'google_reset' && hasLinkedEmail && (
                  <form onSubmit={handleGooglePasswordReset} className="space-y-4">
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700">
                      Conta vinculada: <strong className="font-mono">{maskedEmail}</strong>
                    </div>

                    <div>
                      <label
                        htmlFor="reset-new-password"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        Nova Senha
                      </label>
                      <div className="relative">
                        <input
                          id="reset-new-password"
                          type={showNewPassword ? 'text' : 'password'}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="Mínimo 4 caracteres"
                          className="w-full pl-3.5 pr-10 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#FFC000]"
                          disabled={busy}
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword((prev) => !prev)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
                        >
                          {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor="reset-confirm-password"
                        className="block text-xs font-semibold text-slate-700 mb-1"
                      >
                        Confirmar Nova Senha
                      </label>
                      <input
                        id="reset-confirm-password"
                        type={showNewPassword ? 'text' : 'password'}
                        value={confirmNewPassword}
                        onChange={(e) => setConfirmNewPassword(e.target.value)}
                        placeholder="Repita a nova senha"
                        className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#FFC000]"
                        disabled={busy}
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={busy}
                      className="w-full py-2.5 px-5 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-[#FFC000] font-bold text-sm rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <KeyRound className="w-4 h-4" />
                      <span>{submitting ? 'Validando com Google...' : 'Validar com Google e Salvar Senha'}</span>
                    </button>
                  </form>
                )}

                {forgotStep === 'requested' && (
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={backToLogin}
                      className="w-full py-2.5 px-5 bg-slate-900 hover:bg-slate-800 text-[#FFC000] font-bold text-sm rounded-lg transition-colors cursor-pointer"
                    >
                      Voltar para a tela de login
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
