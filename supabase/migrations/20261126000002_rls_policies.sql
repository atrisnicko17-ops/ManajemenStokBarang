-- ============================================================================
-- 002_rls_policies.sql
-- GudangKu WMS — Multi-Tenant Row-Level Security (RLS) & Column Privilege
-- Hardening (Isolasi Ketat HPP cost_price dari Staf Lapangan / DevTools)
-- ============================================================================

-- 1. FUNGSI HELPER DI SKEMA PRIVAT (Mencegah pemanggilan langsung oleh anon/PUBLIC)
CREATE OR REPLACE FUNCTION private.get_auth_tenant_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
    SELECT u.tenant_id
    FROM public.users u
    WHERE u.id = (SELECT auth.uid())
      AND u.is_active = TRUE
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION private.get_auth_role()
RETURNS VARCHAR(20)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
    SELECT u.role
    FROM public.users u
    WHERE u.id = (SELECT auth.uid())
      AND u.is_active = TRUE
    LIMIT 1;
$$;

REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.get_auth_tenant_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.get_auth_role() FROM PUBLIC, anon, authenticated;

-- 2. PROTEKSI LEVEL KOLOM UNTUK HPP (cost_price)
-- Mencabut akses SELECT/INSERT/UPDATE langsung ke kolom cost_price bagi anon & authenticated
-- sehingga Staf Lapangan (OPERATOR) mustahil mengintip cost_price via Network/PostgREST!
REVOKE ALL ON public.items FROM anon, authenticated;

GRANT SELECT (
    id, tenant_id, sku_code, barcode, name, category, default_bin_code,
    base_unit, min_stock, is_fixed_asset, asset_condition, image_url, updated_at
) ON public.items TO authenticated;

GRANT SELECT ON public.v_items_operator TO authenticated;

-- Cabut akses anonim penuh pada seluruh tabel bisnis
REVOKE ALL ON public.tenants, public.users, public.warehouses, public.bin_locations,
    public.item_uoms, public.inventory_balances, public.stock_requests,
    public.stock_ledger, public.audit_logs
FROM anon;

-- 3. AKTIFKAN ROW LEVEL SECURITY (RLS) DI SELURUH TABEL SKEMA PUBLIC
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bin_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_uoms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- 4. KEBIJAKAN RLS MULTI-TENANT DENGAN SUBQUERY CACHING ((SELECT ...))
-- Tenants
CREATE POLICY "tenants_select_own" ON public.tenants
    FOR SELECT TO authenticated
    USING (id = (SELECT private.get_auth_tenant_id()));

CREATE POLICY "tenants_update_admin" ON public.tenants
    FOR UPDATE TO authenticated
    USING (
        id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) = 'ADMIN'
    )
    WITH CHECK (
        id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) = 'ADMIN'
    );

-- Users
CREATE POLICY "users_select_same_tenant" ON public.users
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT private.get_auth_tenant_id()));

CREATE POLICY "users_update_self_or_admin" ON public.users
    FOR UPDATE TO authenticated
    USING (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (
            id = (SELECT auth.uid())
            OR (SELECT private.get_auth_role()) = 'ADMIN'
        )
    )
    WITH CHECK (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (
            id = (SELECT auth.uid())
            OR (SELECT private.get_auth_role()) = 'ADMIN'
        )
    );

-- Warehouses
CREATE POLICY "warehouses_select_tenant" ON public.warehouses
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT private.get_auth_tenant_id()));

CREATE POLICY "warehouses_write_admin" ON public.warehouses
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) = 'ADMIN'
    );

CREATE POLICY "warehouses_update_admin" ON public.warehouses
    FOR UPDATE TO authenticated
    USING (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) = 'ADMIN'
    )
    WITH CHECK (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) = 'ADMIN'
    );

-- Bin Locations
CREATE POLICY "bins_select_tenant" ON public.bin_locations
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT private.get_auth_tenant_id()));

CREATE POLICY "bins_write_supervisor" ON public.bin_locations
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) IN ('ADMIN', 'APPROVER')
    );

CREATE POLICY "bins_update_supervisor" ON public.bin_locations
    FOR UPDATE TO authenticated
    USING (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) IN ('ADMIN', 'APPROVER')
    )
    WITH CHECK (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) IN ('ADMIN', 'APPROVER')
    );

-- Items & Item UOMs
CREATE POLICY "items_select_tenant" ON public.items
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT private.get_auth_tenant_id()));

CREATE POLICY "item_uoms_select_tenant" ON public.item_uoms
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT private.get_auth_tenant_id()));

CREATE POLICY "item_uoms_write_admin" ON public.item_uoms
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) = 'ADMIN'
    );

-- Inventory Balances (Baca oleh tenant; perubahan saldo WAJIB melewati RPC atomik)
CREATE POLICY "balances_select_tenant" ON public.inventory_balances
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT private.get_auth_tenant_id()));

-- Stock Requests
CREATE POLICY "requests_select_tenant" ON public.stock_requests
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT private.get_auth_tenant_id()));

CREATE POLICY "requests_insert_tenant" ON public.stock_requests
    FOR INSERT TO authenticated
    WITH CHECK (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND requested_by = (SELECT auth.uid())
    );

CREATE POLICY "requests_update_approver_or_fulfiller" ON public.stock_requests
    FOR UPDATE TO authenticated
    USING (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) IN ('ADMIN', 'APPROVER', 'OPERATOR')
    )
    WITH CHECK (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) IN ('ADMIN', 'APPROVER', 'OPERATOR')
    );

-- Stock Ledger (Hanya SELECT untuk tenant; INSERT hanya via RPC atomik; UPDATE/DELETE diblokir trigger)
CREATE POLICY "ledger_select_tenant" ON public.stock_ledger
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT private.get_auth_tenant_id()));

-- Audit Logs (Hanya ADMIN & APPROVER yang dapat melihat log audit lengkap)
CREATE POLICY "audit_select_supervisor" ON public.audit_logs
    FOR SELECT TO authenticated
    USING (
        tenant_id = (SELECT private.get_auth_tenant_id())
        AND (SELECT private.get_auth_role()) IN ('ADMIN', 'APPROVER')
    );
