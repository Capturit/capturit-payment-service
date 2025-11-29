import {
  pricingPlans,
  capturitWebPlan,
  products,
  type PricingPlan,
  type CapturitWebPlan,
} from '@capturit/shared';
import { eq, and } from 'drizzle-orm';
import type { DbClient } from '@capturit/shared';
import type { CatalogProduct } from '../types/catalog.types';

export class CatalogService {
  constructor(private db: DbClient) {}

  /**
   * Récupère tous les produits du catalogue
   */
  async getAllProducts(): Promise<CatalogProduct[]> {
    const [webPlans, productionPlans, stripeProducts] = await Promise.all([
      this.getWebPlans(),
      this.getProductionPlans(),
      this.db.select().from(products),
    ]);

    // Créer une map des stripe IDs
    const stripeMap = new Map(stripeProducts.map(p => [p.id, p]));

    // Combiner et transformer
    const allProducts: CatalogProduct[] = [
      ...webPlans.map(plan => this.transformWebPlan(plan, stripeMap.get(plan.slug))),
      ...productionPlans.map(plan => this.transformProductionPlan(plan, stripeMap.get(plan.slug || ''))),
    ];

    // Trier par displayOrder puis par catégorie
    return allProducts.sort((a, b) => {
      if (a.category !== b.category) {
        const order = { web: 0, production: 1, alacarte: 2 };
        return order[a.category] - order[b.category];
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

    // Chercher dans production plans
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
      id: plan.id.toString(),
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
    const isAlaCarte = plan.slug?.includes('alacarte') || false;

    return {
      id: plan.id.toString(),
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
}
