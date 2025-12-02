// Types pour le catalogue unifié

export interface CatalogProduct {
  id: string;
  slug: string;
  name: string;
  description: string | null;

  // Catégorie
  category: 'web' | 'production' | 'alacarte';
  type: 'subscription' | 'one_time';

  // Prix (en centimes)
  price: number;
  monthlyPrice?: number;
  yearlyPrice?: number;
  setupFee?: number;
  currency: string;

  // Billing
  billingPeriod: 'monthly' | 'yearly' | 'one_time';

  // Stripe IDs
  stripeProductId: string | null;
  stripePriceId: string | null;

  // Affichage
  features: string[];
  isPopular: boolean;
  isCustom: boolean;
  displayOrder: number;

  // Status
  isActive: boolean;

  // Storage quota (pour clients)
  storageGb: number;
}

export interface CatalogResponse {
  success: boolean;
  data: CatalogProduct[];
  meta: {
    total: number;
    categories: {
      web: number;
      production: number;
      alacarte: number;
    };
  };
}

export interface SingleProductResponse {
  success: boolean;
  data: CatalogProduct;
}

export interface CategoryResponse {
  success: boolean;
  data: CatalogProduct[];
  meta: {
    total: number;
  };
}

// Input types for CRUD operations
export interface CreateCatalogProductInput {
  slug: string;
  name: string;
  description?: string | null;
  category: 'web' | 'production' | 'alacarte';
  type: 'subscription' | 'one_time';
  price: number; // en centimes
  monthlyPrice?: number;
  yearlyPrice?: number;
  setupFee?: number;
  currency?: string;
  billingPeriod?: 'monthly' | 'yearly' | 'one_time';
  features?: string[];
  isPopular?: boolean;
  isCustom?: boolean;
  displayOrder?: number;
  isActive?: boolean;
  storageGb?: number;
  buttonText?: string;
}

export interface UpdateCatalogProductInput {
  name?: string;
  description?: string | null;
  price?: number;
  monthlyPrice?: number;
  yearlyPrice?: number;
  setupFee?: number;
  features?: string[];
  isPopular?: boolean;
  isCustom?: boolean;
  displayOrder?: number;
  isActive?: boolean;
  storageGb?: number;
  buttonText?: string;
}

export interface MutationResponse {
  success: boolean;
  data?: CatalogProduct;
  error?: string;
}

export interface DeleteResponse {
  success: boolean;
  message?: string;
  error?: string;
}
