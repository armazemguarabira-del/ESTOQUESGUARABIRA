import React, { useState, useMemo } from 'react';
import {
  UserPlus,
  Search,
  Edit3,
  Trash2,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  UserCheck,
  UserX,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import {
  PublicUser,
  UserRole,
  USER_ROLE_LABELS,
  DEFAULT_SECTORS,
} from '../types/auth';
import {
  registerUserInFirestore,
  updateUserInFirestore,
  deleteUserFromFirestore,
  generateProvisionalPasswordForUser,
} from '../firebase';
import { normalizeUsername } from '../utils/authCrypto';

interface CadastroUsuariosViewProps {
  currentUser: PublicUser;
  users: PublicUser[];
  onNotify: (message: string) => void;
}

export const CadastroUsuariosView: React.FC<CadastroUsuariosViewProps> = ({
  currentUser,
  users,
  onNotify,
}) => {
  // Formulário de cadastro
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('operador');
  const [sector, setSector] = useState<string>(DEFAULT_SECTORS[0]);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mustChangeOnFirstLogin, setMustChangeOnFirstLogin] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  // Filtros da tabela
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  // Edição de usuário
  const [editingUser, setEditingUser] = useState<PublicUser | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('operador');
  const [editSector, setEditSector] = useState('');
  const [editNewPassword, setEditNewPassword] = useState('');
  const [editMustChange, setEditMustChange] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Senha provisória gerada para exibição ao Admin
  const [generatedProvisional, setGeneratedProvisional] = useState<{
    username: string;
    fullName: string;
    password: string;
  } | null>(null);
  const [copiedProvisional, setCopiedProvisional] = useState(false);

  // Confirmação de exclusão
  const [userToDelete, setUserToDelete] = useState<PublicUser | null>(null);

  const isAdmin = currentUser.role === 'admin';

  const activeAdminCount = useMemo(
    () => users.filter((u) => u.role === 'admin' && u.active !== false).length,
    [users]
  );

  const pendingResetUsers = useMemo(
    () => users.filter((u) => u.passwordResetRequested),
    [users]
  );

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return users.filter((u) => {
      if (statusFilter === 'active' && u.active === false) return false;
      if (statusFilter === 'inactive' && u.active !== false) return false;
      if (!q) return true;
      return (
        u.username.toLowerCase().includes(q) ||
        u.fullName.toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        u.sector.toLowerCase().includes(q) ||
        USER_ROLE_LABELS[u.role].toLowerCase().includes(q)
      );
    });
  }, [users, searchQuery, statusFilter]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);

    if (fullName.trim().length < 3) {
      setFormError('Informe o nome completo (mínimo 3 caracteres).');
      return;
    }

    const normalized = normalizeUsername(username);
    if (normalized.length < 3) {
      setFormError('O usuário deve ter pelo menos 3 caracteres.');
      return;
    }

    if (password.length < 4) {
      setFormError('A senha deve ter pelo menos 4 caracteres.');
      return;
    }

    if (password !== confirmPassword) {
      setFormError('As senhas digitadas não conferem.');
      return;
    }

    const effectiveRole: UserRole = isAdmin ? role : role === 'admin' ? 'operador' : role;

    setSubmitting(true);
    try {
      const res = await registerUserInFirestore({
        username: normalized,
        fullName: fullName.trim(),
        email: email.trim() || undefined,
        password,
        role: effectiveRole,
        sector,
        mustChangePassword: mustChangeOnFirstLogin,
        createdBy: currentUser.username,
      });

      if (res.success && res.user) {
        setFormSuccess(`Usuário "${res.user.username}" cadastrado com sucesso!`);
        onNotify(`✓ Usuário "${res.user.username}" (${res.user.fullName}) cadastrado!`);
        setFullName('');
        setUsername('');
        setEmail('');
        setPassword('');
        setConfirmPassword('');
        setRole('operador');
      } else {
        setFormError(res.error || 'Erro ao cadastrar usuário.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openEditModal = (u: PublicUser) => {
    setEditingUser(u);
    setEditFullName(u.fullName);
    setEditEmail(u.email || '');
    setEditRole(u.role);
    setEditSector(u.sector);
    setEditNewPassword('');
    setEditMustChange(Boolean(u.mustChangePassword));
    setEditError(null);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setEditError(null);

    if (
      editingUser.role === 'admin' &&
      editRole !== 'admin' &&
      activeAdminCount <= 1
    ) {
      setEditError('Não é possível rebaixar o único Administrador ativo do sistema.');
      return;
    }

    setSavingEdit(true);
    try {
      const res = await updateUserInFirestore(
        editingUser.username,
        {
          fullName: editFullName,
          email: editEmail,
          role: isAdmin ? editRole : editingUser.role,
          sector: editSector,
          newPassword: editNewPassword || undefined,
          mustChangePassword: editNewPassword ? editMustChange : undefined,
        },
        currentUser.username
      );
      if (res.success) {
        onNotify(`✓ Dados do usuário "${editingUser.username}" atualizados!`);
        setEditingUser(null);
      } else {
        setEditError(res.error || 'Erro ao atualizar usuário.');
      }
    } finally {
      setSavingEdit(false);
    }
  };

  const handleGenerateProvisional = async (u: PublicUser) => {
    const res = await generateProvisionalPasswordForUser(u.username, currentUser.username);
    if (res.success && res.provisionalPassword) {
      setGeneratedProvisional({
        username: u.username,
        fullName: u.fullName,
        password: res.provisionalPassword,
      });
      setCopiedProvisional(false);
      onNotify(`✓ Senha provisória gerada para "${u.username}".`);
    } else {
      onNotify(`⚠️ ${res.error || 'Falha ao gerar senha provisória.'}`);
    }
  };

  const handleCopyProvisional = async () => {
    if (!generatedProvisional) return;
    try {
      await navigator.clipboard.writeText(
        `Usuário: ${generatedProvisional.username}\nSenha provisória: ${generatedProvisional.password}`
      );
      setCopiedProvisional(true);
    } catch {}
  };

  const handleToggleActive = async (u: PublicUser) => {
    if (u.username === currentUser.username) {
      onNotify('⚠️ Você não pode desativar o próprio usuário conectado.');
      return;
    }
    if (u.role === 'admin' && u.active !== false && activeAdminCount <= 1) {
      onNotify('⚠️ Não é possível desativar o único Administrador ativo.');
      return;
    }
    const nextActive = u.active === false;
    const res = await updateUserInFirestore(
      u.username,
      { active: nextActive },
      currentUser.username
    );
    if (res.success) {
      onNotify(
        nextActive
          ? `✓ Usuário "${u.username}" reativado.`
          : `Usuário "${u.username}" desativado.`
      );
    } else {
      onNotify(`⚠️ ${res.error || 'Falha ao alterar status.'}`);
    }
  };

  const handleConfirmDelete = async () => {
    if (!userToDelete) return;
    if (userToDelete.username === currentUser.username) {
      onNotify('⚠️ Você não pode excluir o próprio usuário conectado.');
      setUserToDelete(null);
      return;
    }
    if (userToDelete.role === 'admin' && userToDelete.active !== false && activeAdminCount <= 1) {
      onNotify('⚠️ Não é possível excluir o único Administrador ativo.');
      setUserToDelete(null);
      return;
    }

    const res = await deleteUserFromFirestore(userToDelete.username, currentUser.username);
    if (res.success) {
      onNotify(`Usuário "${userToDelete.username}" removido do sistema.`);
    } else {
      onNotify(`⚠️ ${res.error || 'Falha ao excluir usuário.'}`);
    }
    setUserToDelete(null);
  };

  const formatDateTime = (iso?: string) => {
    if (!iso) return '—';
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const totalAtivos = users.filter((u) => u.active !== false).length;
  const totalAdmins = users.filter((u) => u.role === 'admin').length;

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Cabeçalho da Guia */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
            Cadastro de Usuários
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 mt-1">
            Gerencie contas de acesso, vincule contas Google, emita senhas provisórias e defina perfis da equipe.
          </p>
        </div>

        <div className="flex items-center gap-6 text-xs text-slate-600 tabular-nums">
          <div>
            <span className="text-slate-400">Total: </span>
            <strong className="text-slate-900 font-bold">{users.length}</strong>
          </div>
          <div>
            <span className="text-slate-400">Ativos: </span>
            <strong className="text-emerald-700 font-bold">{totalAtivos}</strong>
          </div>
          <div>
            <span className="text-slate-400">Administradores: </span>
            <strong className="text-slate-900 font-bold">{totalAdmins}</strong>
          </div>
        </div>
      </div>

      {/* Solicitações Pendentes de "Esqueceu a Senha" */}
      {isAdmin && pendingResetUsers.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <KeyRound className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-amber-950">
                Solicitações de redefinição de senha ({pendingResetUsers.length})
              </p>
              <p className="text-xs text-amber-800 mt-0.5">
                Os seguintes usuários solicitaram recuperação de acesso na tela de login:
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {pendingResetUsers.map((u) => (
              <button
                key={u.username}
                type="button"
                onClick={() => handleGenerateProvisional(u)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-[#FFC000] text-xs font-bold rounded-lg transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Gerar provisória para {u.username}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Formulário de Novo Cadastro */}
        <section className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 sm:p-6">
          <div className="flex items-center gap-2.5 pb-4 mb-5 border-b border-slate-100">
            <div className="w-8 h-8 rounded-lg bg-slate-900 text-[#FFC000] flex items-center justify-center shrink-0">
              <UserPlus className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Novo Usuário</h2>
              <p className="text-xs text-slate-500">Cadastro interno de acesso ao sistema</p>
            </div>
          </div>

          {formError && (
            <div
              role="alert"
              className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{formError}</span>
            </div>
          )}

          {formSuccess && (
            <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <span>{formSuccess}</span>
            </div>
          )}

          <form onSubmit={handleCreateUser} className="space-y-4">
            <div>
              <label htmlFor="cad-fullname" className="block text-xs font-semibold text-slate-700 mb-1">
                Nome Completo
              </label>
              <input
                id="cad-fullname"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Ex: Maria Oliveira"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
                disabled={submitting}
              />
            </div>

            <div>
              <label htmlFor="cad-username" className="block text-xs font-semibold text-slate-700 mb-1">
                Usuário (Login)
              </label>
              <input
                id="cad-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Ex: maria.oliveira"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
                disabled={submitting}
              />
              {username.trim().length > 0 && (
                <p className="text-[11px] text-slate-500 mt-1 font-mono">
                  Identificador: {normalizeUsername(username) || '—'}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="cad-email" className="block text-xs font-semibold text-slate-700 mb-1">
                E-mail Google (opcional, para login Google e recuperação)
              </label>
              <input
                id="cad-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Ex: usuario@gmail.com"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
                disabled={submitting}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="cad-role" className="block text-xs font-semibold text-slate-700 mb-1">
                  Perfil
                </label>
                <select
                  id="cad-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as UserRole)}
                  className="w-full px-2.5 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
                  disabled={submitting}
                >
                  <option value="operador">{USER_ROLE_LABELS.operador}</option>
                  <option value="conferente">{USER_ROLE_LABELS.conferente}</option>
                  {isAdmin && <option value="admin">{USER_ROLE_LABELS.admin}</option>}
                </select>
              </div>

              <div>
                <label htmlFor="cad-sector" className="block text-xs font-semibold text-slate-700 mb-1">
                  Setor
                </label>
                <select
                  id="cad-sector"
                  value={sector}
                  onChange={(e) => setSector(e.target.value)}
                  className="w-full px-2.5 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
                  disabled={submitting}
                >
                  {DEFAULT_SECTORS.map((sec) => (
                    <option key={sec} value={sec}>
                      {sec}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="cad-password" className="block text-xs font-semibold text-slate-700 mb-1">
                Senha Inicial
              </label>
              <div className="relative">
                <input
                  id="cad-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 4 caracteres"
                  className="w-full pl-3 pr-10 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
                  disabled={submitting}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="cad-confirm" className="block text-xs font-semibold text-slate-700 mb-1">
                Confirmar Senha
              </label>
              <input
                id="cad-confirm"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repita a senha"
                className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
                disabled={submitting}
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={mustChangeOnFirstLogin}
                onChange={(e) => setMustChangeOnFirstLogin(e.target.checked)}
                className="rounded border-slate-300 text-slate-900 focus:ring-[#FFC000]"
              />
              <span>Definir como senha provisória (solicitar troca ao entrar)</span>
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 px-4 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-[#FFC000] font-bold text-sm rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <UserPlus className="w-4 h-4" />
              <span>{submitting ? 'Salvando...' : 'Cadastrar Usuário'}</span>
            </button>
          </form>
        </section>

        {/* Lista de Usuários Cadastrados */}
        <section className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar por nome, usuário, e-mail ou setor..."
                className="w-full pl-9 pr-3 py-2 text-xs sm:text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#FFC000] focus:border-slate-900"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 self-start sm:self-auto">
              {(['all', 'active', 'inactive'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    statusFilter === st
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st === 'all' ? 'Todos' : st === 'active' ? 'Ativos' : 'Inativos'}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-bold text-slate-600">
                  <th className="py-3 px-4">Usuário</th>
                  <th className="py-3 px-4">Nome Completo</th>
                  <th className="py-3 px-4">Perfil</th>
                  <th className="py-3 px-4">Setor</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Último Acesso</th>
                  <th className="py-3 px-4 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 px-4 text-center text-slate-500">
                      Nenhum usuário encontrado para o filtro selecionado.
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((u) => {
                    const isSelf = u.username === currentUser.username;
                    const isActive = u.active !== false;
                    const canManageTarget = isAdmin || isSelf;

                    return (
                      <tr key={u.username} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-3 px-4 font-mono text-xs font-semibold text-slate-900 whitespace-nowrap">
                          <div>{u.username}</div>
                          {u.email && (
                            <div className="text-[11px] font-sans font-normal text-slate-500">
                              {u.email}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 font-medium text-slate-900">
                          <span>{u.fullName}</span>
                          {isSelf && (
                            <span className="ml-1.5 text-[11px] text-slate-500 font-normal">
                              (você)
                            </span>
                          )}
                          {u.mustChangePassword && (
                            <div className="text-[11px] text-amber-700 font-normal">
                              Senha provisória ativa
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-700 whitespace-nowrap">
                          {USER_ROLE_LABELS[u.role]}
                        </td>
                        <td className="py-3 px-4 text-slate-600 whitespace-nowrap">
                          {u.sector}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span
                            className={`text-xs font-semibold ${
                              isActive ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            {isActive ? 'Ativo' : 'Inativo'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-500 tabular-nums whitespace-nowrap">
                          {formatDateTime(u.lastLoginAt || u.createdAt)}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            {canManageTarget && (
                              <button
                                type="button"
                                onClick={() => openEditModal(u)}
                                title="Editar dados ou definir nova senha"
                                className="p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                            )}

                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() => handleGenerateProvisional(u)}
                                title="Gerar nova senha provisória"
                                className="p-1.5 text-amber-700 hover:text-amber-900 hover:bg-amber-50 rounded-md transition-colors cursor-pointer"
                              >
                                <KeyRound className="w-4 h-4" />
                              </button>
                            )}

                            {isAdmin && !isSelf && (
                              <button
                                type="button"
                                onClick={() => handleToggleActive(u)}
                                title={isActive ? 'Desativar usuário' : 'Reativar usuário'}
                                className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                                  isActive
                                    ? 'text-amber-700 hover:bg-amber-50'
                                    : 'text-emerald-700 hover:bg-emerald-50'
                                }`}
                              >
                                {isActive ? (
                                  <UserX className="w-4 h-4" />
                                ) : (
                                  <UserCheck className="w-4 h-4" />
                                )}
                              </button>
                            )}

                            {isAdmin && !isSelf && (
                              <button
                                type="button"
                                onClick={() => setUserToDelete(u)}
                                title="Excluir usuário"
                                className="p-1.5 text-red-600 hover:text-red-800 hover:bg-red-50 rounded-md transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Modal de Senha Provisória Gerada */}
      {generatedProvisional && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setGeneratedProvisional(null)}
        >
          <div
            className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-lg p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 pb-3 border-b border-slate-200">
              <KeyRound className="w-5 h-5 text-amber-700" />
              <div>
                <h3 className="text-base font-bold text-slate-900">Senha Provisória Gerada</h3>
                <p className="text-xs text-slate-500">
                  Repasse estas credenciais para {generatedProvisional.fullName}.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-2 text-sm font-mono">
              <div>
                <span className="text-slate-500 font-sans text-xs">Usuário: </span>
                <strong className="text-slate-900">{generatedProvisional.username}</strong>
              </div>
              <div>
                <span className="text-slate-500 font-sans text-xs">Senha provisória: </span>
                <strong className="text-slate-900 select-all">{generatedProvisional.password}</strong>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCopyProvisional}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                {copiedProvisional ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedProvisional ? 'Copiado' : 'Copiar'}</span>
              </button>
              <button
                type="button"
                onClick={() => setGeneratedProvisional(null)}
                className="px-4 py-2 text-xs font-bold text-[#FFC000] bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
              >
                Concluir
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Edição / Alteração de Senha */}
      {editingUser && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setEditingUser(null)}
        >
          <div
            className="w-full max-w-md bg-white border border-slate-200 rounded-xl shadow-lg p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 pb-3 mb-4 border-b border-slate-200">
              <KeyRound className="w-5 h-5 text-slate-900" />
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Editar Usuário: {editingUser.username}
                </h3>
                <p className="text-xs text-slate-500">
                  Atualize os dados ou defina uma nova senha.
                </p>
              </div>
            </div>

            {editError && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                {editError}
              </div>
            )}

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nome Completo
                </label>
                <input
                  type="text"
                  value={editFullName}
                  onChange={(e) => setEditFullName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#FFC000]"
                  disabled={savingEdit}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  E-mail Google
                </label>
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  placeholder="usuario@gmail.com"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#FFC000]"
                  disabled={savingEdit}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Setor
                  </label>
                  <select
                    value={editSector}
                    onChange={(e) => setEditSector(e.target.value)}
                    className="w-full px-2.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#FFC000]"
                    disabled={savingEdit}
                  >
                    {DEFAULT_SECTORS.map((sec) => (
                      <option key={sec} value={sec}>
                        {sec}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Perfil
                  </label>
                  <select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value as UserRole)}
                    disabled={savingEdit || !isAdmin}
                    className="w-full px-2.5 py-2 text-sm border border-slate-300 rounded-lg disabled:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-[#FFC000]"
                  >
                    <option value="operador">{USER_ROLE_LABELS.operador}</option>
                    <option value="conferente">{USER_ROLE_LABELS.conferente}</option>
                    <option value="admin">{USER_ROLE_LABELS.admin}</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nova Senha (deixe em branco para manter a atual)
                </label>
                <input
                  type="password"
                  value={editNewPassword}
                  onChange={(e) => setEditNewPassword(e.target.value)}
                  placeholder="Mínimo 4 caracteres"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#FFC000]"
                  disabled={savingEdit}
                />
              </div>

              {editNewPassword.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editMustChange}
                    onChange={(e) => setEditMustChange(e.target.checked)}
                    className="rounded border-slate-300 text-slate-900"
                  />
                  <span>Definir como senha provisória (exigir troca ao entrar)</span>
                </label>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="px-4 py-2 text-xs font-bold text-[#FFC000] bg-slate-900 hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  {savingEdit ? 'Salvando...' : 'Salvar Alterações'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal de Confirmação de Exclusão */}
      {userToDelete && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setUserToDelete(null)}
        >
          <div
            className="w-full max-w-sm bg-white border border-slate-200 rounded-xl shadow-lg p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-slate-900">Excluir Usuário</h3>
            <p className="text-sm text-slate-600 mt-2">
              Deseja remover permanentemente o usuário{' '}
              <strong className="text-slate-900">{userToDelete.username}</strong> ({userToDelete.fullName})?
            </p>
            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => setUserToDelete(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="px-4 py-2 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer"
              >
                Confirmar Exclusão
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
