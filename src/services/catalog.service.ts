import {
  eq,
  and,
  pricingPlans,
  plans,
  capturitWebPlan,
  products,
  type PricingPlan,
  type Plan,
  type CapturitWebPlan,
} from '@capturit/shared';
import type { DbClient } from '@capturit/shared';
import type {
  CatalogProduct,
  CreateCatalogProductInput,
  UpdateCatalogProductInput
} from '../types/catalog.types';

export class CatalogService {
  constructor(private db: DbClient) {}

  /**
   * Récupère tous les produits du catalogue
   */
  async getAllProducts(): Promise<CatalogProduct[]> {
    const [webPlans, productionPlans, storagePlans, stripeProducts] = await Promise.all([
      this.getWebPlans(),
      this.getProductionPlans(),
      this.getStoragePlans(),
      this.db.select().from(products),
    ]);

    // Créer une map des stripe IDs
    const stripeMap = new Map(stripeProducts.map(p => [p.id, p]));

    // Créer un set des slugs web pour filtrer les doublons
    const webPlanSlugs = new Set(webPlans.map(p => p.slug));

    // Créer un set des slugs storage pour filtrer les doublons
    const storagePlanSlugs = new Set(storagePlans.map(p => p.slug));

    // Filtrer les plans de production qui ont le même slug qu'un plan web OU storage
    const filteredProductionPlans = productionPlans.filter(
      p => !webPlanSlugs.has(p.slug || '') && !storagePlanSlugs.has(p.slug || '')
    );

    // Combiner et transformer
    const allProducts: CatalogProduct[] = [
      ...webPlans.map(plan => this.transformWebPlan(plan, stripeMap.get(plan.slug))),
      ...filteredProductionPlans.map(plan => this.transformProductionPlan(plan, stripeMap.get(plan.slug || ''))),
      ...storagePlans.map(plan => this.transformStoragePlan(plan, stripeMap.get(plan.slug || ''))),
    ];

    // Trier par displayOrder puis par catégorie
    return allProducts.sort((a, b) => {
      if (a.category !== b.category) {
        const order: Record<string, number> = { web: 0, production: 1, alacarte: 2, storage: 3 };
        return (order[a.category] ?? 99) - (order[b.category] ?? 99);
      }
      return a.displayOrder - b.displayOrder;
    });
  }

  /**
   * Récupère les plans Web uniquement
   */
  async getWebPlans(): Promise<CapturitWebPlan[]> {
    return this.db
      .select()
      .from(capturitWebPlan)
      .where(eq(capturitWebPlan.published, true))
      .orderBy(capturitWebPlan.order);
  }

  /**
   * Récupère les plans Production uniquement (formules + à la carte)
   */
  async getProductionPlans(): Promise<PricingPlan[]> {
    return this.db
      .select()
      .from(pricingPlans)
      .where(
        and(
          eq(pricingPlans.active, true),
          eq(pricingPlans.billingPeriod, 'one_time')
        )
      )
      .orderBy(pricingPlans.displayOrder);
  }

  /**
   * Récupère les plans de stockage uniquement
   */
  async getStoragePlans(): Promise<Plan[]> {
    return this.db
      .select()
      .from(plans)
      .where(
        and(
          eq(plans.isActive, true),
          eq(plans.category, 'storage')
        )
      )
      .orderBy(plans.displayOrder);
  }

  /**
   * Transforme un plan Storage en CatalogProduct
   */
  private transformStoragePlan(
    plan: Plan,
    stripeProduct?: typeof products.$inferSelect | null
  ): CatalogProduct {
    return {
      id: `storage-${plan.id}`,
      slug: plan.slug || plan.id,
      name: plan.name,
      description: plan.description,
      category: 'storage',
      type: 'subscription',
      price: plan.priceCents,
      monthlyPrice: plan.priceCents,
      yearlyPrice: plan.yearlyPriceCents || Math.round(plan.priceCents * 12 * 0.85),
      currency: plan.currency,
      billingPeriod: 'monthly',
      stripeProductId: stripeProduct?.stripeProductId || plan.stripeProductId || plan.id,
      stripePriceId: stripeProduct?.stripePriceId || plan.stripePriceId || null,
      features: (plan.features as string[]) || [],
      isPopular: plan.isPopular || false,
      isCustom: plan.isCustom || false,
      displayOrder: plan.displayOrder || 100,
      isActive: plan.isActive,
      storageGb: plan.storageGb || 10,
    };
  }

  /**
   * Récupère un produit par son slug
   */
  async getProductBySlug(slug: string): Promise<CatalogProduct | null> {
    // Chercher dans web plans
    const [webPlan] = await this.db
      .select()
      .from(capturitWebPlan)
      .where(eq(capturitWebPlan.slug, slug))
      .limit(1);

    if (webPlan) {
      const [stripeProduct] = await this.db
        .select()
        .from(products)
        .where(eq(products.id, slug))
        .limit(1);
      return this.transformWebPlan(webPlan, stripeProduct);
    }

    // Chercher dans production plans (via VIEW)
    const [productionPlan] = await this.db
      .select()
      .from(pricingPlans)
      .where(eq(pricingPlans.slug, slug))
      .limit(1);

    if (productionPlan) {
      const [stripeProduct] = await this.db
        .select()
        .from(products)
        .where(eq(products.id, slug))
        .limit(1);
      return this.transformProductionPlan(productionPlan, stripeProduct);
    }

    // Chercher dans la table plans (pour storage et autres)
    const [storagePlan] = await this.db
      .select()
      .from(plans)
      .where(eq(plans.slug, slug))
      .limit(1);

    if (storagePlan) {
      const [stripeProduct] = await this.db
        .select()
        .from(products)
        .where(eq(products.id, slug))
        .limit(1);
      if (storagePlan.category === 'storage') {
        return this.transformStoragePlan(storagePlan, stripeProduct);
      }
      return this.transformPlanToCatalog(storagePlan);
    }

    return null;
  }

  /**
   * Transforme un plan Web en CatalogProduct
   */
  private transformWebPlan(
    plan: CapturitWebPlan,
    stripeProduct?: typeof products.$inferSelect | null
  ): CatalogProduct {
    return {
      id: `web-${plan.id}`,
      slug: plan.slug,
      name: plan.name,
      description: plan.description,
      category: 'web',
      type: 'subscription',
      price: plan.monthlyPrice,
      monthlyPrice: plan.monthlyPrice,
      yearlyPrice: plan.yearlyPrice,
      setupFee: plan.setupFee,
      currency: 'EUR',
      billingPeriod: 'monthly',
      stripeProductId: stripeProduct?.stripeProductId || null,
      stripePriceId: stripeProduct?.stripePriceId || null,
      features: (plan.features as string[]) || [],
      isPopular: plan.isPopular,
      isCustom: plan.isCustom,
      displayOrder: plan.order,
      isActive: plan.published,
      storageGb: plan.slug === 'starter' ? 1 : plan.slug === 'growth' ? 5 : 20,
    };
  }

  /**
   * Transforme un plan Production en CatalogProduct
   */
  private transformProductionPlan(
    plan: PricingPlan,
    stripeProduct?: typeof products.$inferSelect | null
  ): CatalogProduct {
    const isAlaCarte = plan.slug?.includes('alacarte') || (plan.displayOrder >= 20 && plan.displayOrder < 100);
    const category = isAlaCarte ? 'alacarte' : 'production';

    return {
      id: `${category}-${plan.id}`,
      slug: plan.slug || plan.planId,
      name: plan.name,
      description: plan.description,
      category: isAlaCarte ? 'alacarte' : 'production',
      type: 'one_time',
      price: plan.price,
      currency: plan.currency,
      billingPeriod: 'one_time',
      stripeProductId: stripeProduct?.stripeProductId || plan.planId,
      stripePriceId: stripeProduct?.stripePriceId || null,
      features: (plan.features as string[]) || [],
      isPopular: plan.featured,
      isCustom: false,
      displayOrder: plan.displayOrder,
      isActive: plan.active,
      storageGb: plan.storageGb,
    };
  }

  // ============================================
  // CRUD Operations
  // ============================================

  /**
   * Créer un nouveau produit dans le catalogue
   */
  async createProduct(input: CreateCatalogProductInput): Promise<CatalogProduct> {
    if (input.category === 'web') {
      // Créer dans capturit_web_plan
      const [newPlan] = await this.db.insert(capturitWebPlan).values({
        slug: input.slug,
        name: input.name,
        description: input.description || null,
        monthlyPrice: input.monthlyPrice || input.price,
        yearlyPrice: input.yearlyPrice || Math.round(input.price * 0.85 * 12),
        setupFee: input.setupFee || 30000,
        features: input.features || [],
        order: input.displayOrder || 0,
        published: input.isActive ?? true,
        isPopular: input.isPopular ?? false,
        isCustom: input.isCustom ?? false,
        buttonText: input.buttonText || 'Commencer',
      }).returning();

      return this.transformWebPlan(newPlan, null);
    } else {
      // Créer dans la vraie table plans (pas la VIEW pricingPlans)
      const planId = `plan_${input.slug}_${Date.now()}`;
      const [newPlan] = await this.db.insert(plans).values({
        id: planId,
        slug: input.slug,
        name: input.name,
        description: input.description || null,
        priceCents: input.price,
        currency: input.currency || 'eur',
        type: 'one_time',
        recurring: false,
        billingPeriod: 'one_time',
        features: input.features || [],
        displayOrder: input.displayOrder || (input.category === 'alacarte' ? 20 : 10),
        isPopular: input.isPopular ?? false,
        isActive: input.isActive ?? true,
        storageGb: input.storageGb || 5,
        category: input.category,
      }).returning();

      return this.transformPlanToCatalog(newPlan);
    }
  }

  /**
   * Mettre à jour un produit existant
   */
  async updateProduct(slug: string, input: UpdateCatalogProductInput): Promise<CatalogProduct | null> {
    // Chercher dans web plans
    const [webPlan] = await this.db
      .select()
      .from(capturitWebPlan)
      .where(eq(capturitWebPlan.slug, slug))
      .limit(1);

    if (webPlan) {
      const [updated] = await this.db
        .update(capturitWebPlan)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.monthlyPrice !== undefined && { monthlyPrice: input.monthlyPrice }),
          ...(input.yearlyPrice !== undefined && { yearlyPrice: input.yearlyPrice }),
          ...(input.setupFee !== undefined && { setupFee: input.setupFee }),
          ...(input.features !== undefined && { features: input.features }),
          ...(input.displayOrder !== undefined && { order: input.displayOrder }),
          ...(input.isActive !== undefined && { published: input.isActive }),
          ...(input.isPopular !== undefined && { isPopular: input.isPopular }),
          ...(input.isCustom !== undefined && { isCustom: input.isCustom }),
          ...(input.buttonText !== undefined && { buttonText: input.buttonText }),
          updatedAt: new Date(),
        })
        .where(eq(capturitWebPlan.slug, slug))
        .returning();

      return this.transformWebPlan(updated, null);
    }

    // Chercher dans la vraie table plans (pas la VIEW pricingPlans)
    const [productionPlan] = await this.db
      .select()
      .from(plans)
      .where(eq(plans.slug, slug))
      .limit(1);

    if (productionPlan) {
      const [updated] = await this.db
        .update(plans)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.price !== undefined && { priceCents: input.price }),
          ...(input.features !== undefined && { features: input.features }),
          ...(input.displayOrder !== undefined && { displayOrder: input.displayOrder }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
          ...(input.isPopular !== undefined && { isPopular: input.isPopular }),
          ...(input.storageGb !== undefined && { storageGb: input.storageGb }),
          updatedAt: new Date(),
        })
        .where(eq(plans.slug, slug))
        .returning();

      // Transform the Plan type to CatalogProduct
      return this.transformPlanToCatalog(updated);
    }

    return null;
  }

  /**
   * Transforme un Plan (table plans) en CatalogProduct
   */
  private transformPlanToCatalog(plan: Plan): CatalogProduct {
    const isAlaCarte = plan.slug?.includes('alacarte') || (plan.displayOrder && plan.displayOrder >= 20 && plan.displayOrder < 100);
    const category = plan.category || (isAlaCarte ? 'alacarte' : 'production');

    return {
      id: `${category}-${plan.id}`,
      slug: plan.slug || plan.id,
      name: plan.name,
      description: plan.description,
      category: category as 'web' | 'production' | 'alacarte',
      type: plan.type as 'subscription' | 'one_time',
      price: plan.priceCents,
      currency: plan.currency,
      billingPeriod: (plan.billingPeriod || 'one_time') as 'one_time' | 'monthly' | 'yearly',
      stripeProductId: plan.stripeProductId || plan.id,
      stripePriceId: plan.stripePriceId || null,
      features: (plan.features as string[]) || [],
      isPopular: plan.isPopular || false,
      isCustom: plan.isCustom || false,
      displayOrder: plan.displayOrder || 0,
      isActive: plan.isActive,
      storageGb: plan.storageGb || 5,
    };
  }

  /**
   * Supprimer un produit
   */
  async deleteProduct(slug: string): Promise<boolean> {
    // Chercher et supprimer dans web plans
    const webResult = await this.db
      .delete(capturitWebPlan)
      .where(eq(capturitWebPlan.slug, slug))
      .returning();

    if (webResult.length > 0) {
      return true;
    }

    // Chercher et supprimer dans la vraie table plans (pas la VIEW pricingPlans)
    const productionResult = await this.db
      .delete(plans)
      .where(eq(plans.slug, slug))
      .returning();

    return productionResult.length > 0;
  }

  /**
   * Récupère tous les produits (y compris inactifs) pour l'admin
   */
  async getAllProductsAdmin(): Promise<CatalogProduct[]> {
    const [webPlans, productionPlans, storagePlans, stripeProducts] = await Promise.all([
      this.db.select().from(capturitWebPlan).orderBy(capturitWebPlan.order),
      this.db.select().from(pricingPlans).orderBy(pricingPlans.displayOrder),
      this.db.select().from(plans).where(eq(plans.category, 'storage')).orderBy(plans.displayOrder),
      this.db.select().from(products),
    ]);

    const stripeMap = new Map(stripeProducts.map(p => [p.id, p]));

    // Créer un set des slugs web pour filtrer les doublons
    const webPlanSlugs = new Set(webPlans.map(p => p.slug));

    // Créer un set des slugs storage pour filtrer les doublons
    const storagePlanSlugs = new Set(storagePlans.map(p => p.slug));

    // Filtrer les plans de production qui ont le même slug qu'un plan web OU storage
    const filteredProductionPlans = productionPlans.filter(
      p => !webPlanSlugs.has(p.slug || '') && !storagePlanSlugs.has(p.slug || '')
    );

    const allProducts: CatalogProduct[] = [
      ...webPlans.map(plan => this.transformWebPlan(plan, stripeMap.get(plan.slug))),
      ...filteredProductionPlans.map(plan => this.transformProductionPlan(plan, stripeMap.get(plan.slug || ''))),
      ...storagePlans.map(plan => this.transformStoragePlan(plan, stripeMap.get(plan.slug || ''))),
    ];

    return allProducts.sort((a, b) => {
      if (a.category !== b.category) {
        const order: Record<string, number> = { web: 0, production: 1, alacarte: 2, storage: 3 };
        return (order[a.category] ?? 99) - (order[b.category] ?? 99);
      }
      return a.displayOrder - b.displayOrder;
    });
  }
}
