import { Router, Request, Response } from 'express';
import { CatalogService } from '../services/catalog.service';
import type {
  CatalogResponse,
  CategoryResponse,
  CreateCatalogProductInput,
  UpdateCatalogProductInput,
  MutationResponse,
  DeleteResponse
} from '../types/catalog.types';

export function createCatalogRoutes(catalogService: CatalogService): Router {
  const router = Router();

  /**
   * GET /catalog
   * Récupère tous les produits du catalogue
   */
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const products = await catalogService.getAllProducts();

      const response: CatalogResponse = {
        success: true,
        data: products,
        meta: {
          total: products.length,
          categories: {
            web: products.filter(p => p.category === 'web').length,
            production: products.filter(p => p.category === 'production').length,
            alacarte: products.filter(p => p.category === 'alacarte').length,
          },
        },
      };

      res.json(response);
    } catch (error: any) {
      console.error('[Catalog] Error fetching all products:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération du catalogue',
      });
    }
  });

  /**
   * GET /catalog/web
   * Récupère uniquement les plans Web
   */
  router.get('/web', async (_req: Request, res: Response) => {
    try {
      const products = await catalogService.getAllProducts();
      const webProducts = products.filter(p => p.category === 'web');

      const response: CategoryResponse = {
        success: true,
        data: webProducts,
        meta: { total: webProducts.length },
      };

      res.json(response);
    } catch (error: any) {
      console.error('[Catalog] Error fetching web products:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des plans web',
      });
    }
  });

  /**
   * GET /catalog/production
   * Récupère uniquement les formules Production (pas à la carte)
   */
  router.get('/production', async (_req: Request, res: Response) => {
    try {
      const products = await catalogService.getAllProducts();
      const productionProducts = products.filter(p => p.category === 'production');

      const response: CategoryResponse = {
        success: true,
        data: productionProducts,
        meta: { total: productionProducts.length },
      };

      res.json(response);
    } catch (error: any) {
      console.error('[Catalog] Error fetching production products:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des formules production',
      });
    }
  });

  /**
   * GET /catalog/alacarte
   * Récupère uniquement les services à la carte
   */
  router.get('/alacarte', async (_req: Request, res: Response) => {
    try {
      const products = await catalogService.getAllProducts();
      const alacarteProducts = products.filter(p => p.category === 'alacarte');

      const response: CategoryResponse = {
        success: true,
        data: alacarteProducts,
        meta: { total: alacarteProducts.length },
      };

      res.json(response);
    } catch (error: any) {
      console.error('[Catalog] Error fetching alacarte products:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des services à la carte',
      });
    }
  });

  /**
   * GET /catalog/admin/all
   * Récupère tous les produits y compris inactifs (pour Dashboard Admin)
   */
  router.get('/admin/all', async (_req: Request, res: Response) => {
    try {
      const products = await catalogService.getAllProductsAdmin();

      const response: CatalogResponse = {
        success: true,
        data: products,
        meta: {
          total: products.length,
          categories: {
            web: products.filter(p => p.category === 'web').length,
            production: products.filter(p => p.category === 'production').length,
            alacarte: products.filter(p => p.category === 'alacarte').length,
          },
        },
      };

      res.json(response);
    } catch (error: any) {
      console.error('[Catalog] Error fetching admin products:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération du catalogue admin',
      });
    }
  });

  /**
   * GET /catalog/:slug
   * Récupère un produit par son slug
   */
  router.get('/:slug', async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const product = await catalogService.getProductBySlug(slug);

      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Produit non trouvé',
        });
      }

      res.json({
        success: true,
        data: product,
      });
    } catch (error: any) {
      console.error('[Catalog] Error fetching product:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération du produit',
      });
    }
  });

  // ============================================
  // CRUD Operations (for Dashboard Admin)
  // ============================================

  /**
   * POST /catalog
   * Créer un nouveau produit
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const input: CreateCatalogProductInput = req.body;

      // Validation basique
      if (!input.slug || !input.name || !input.category || !input.type) {
        return res.status(400).json({
          success: false,
          error: 'Les champs slug, name, category et type sont requis',
        });
      }

      if (!['web', 'production', 'alacarte'].includes(input.category)) {
        return res.status(400).json({
          success: false,
          error: 'La catégorie doit être web, production ou alacarte',
        });
      }

      // Vérifier si le slug existe déjà
      const existing = await catalogService.getProductBySlug(input.slug);
      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'Un produit avec ce slug existe déjà',
        });
      }

      const product = await catalogService.createProduct(input);

      const response: MutationResponse = {
        success: true,
        data: product,
      };

      res.status(201).json(response);
    } catch (error: any) {
      console.error('[Catalog] Error creating product:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la création du produit',
      });
    }
  });

  /**
   * PUT /catalog/:slug
   * Mettre à jour un produit existant
   */
  router.put('/:slug', async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const input: UpdateCatalogProductInput = req.body;

      const product = await catalogService.updateProduct(slug, input);

      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Produit non trouvé',
        });
      }

      const response: MutationResponse = {
        success: true,
        data: product,
      };

      res.json(response);
    } catch (error: any) {
      console.error('[Catalog] Error updating product:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la mise à jour du produit',
      });
    }
  });

  /**
   * DELETE /catalog/:slug
   * Supprimer un produit
   */
  router.delete('/:slug', async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;

      const deleted = await catalogService.deleteProduct(slug);

      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: 'Produit non trouvé',
        });
      }

      const response: DeleteResponse = {
        success: true,
        message: `Produit "${slug}" supprimé avec succès`,
      };

      res.json(response);
    } catch (error: any) {
      console.error('[Catalog] Error deleting product:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la suppression du produit',
      });
    }
  });

  return router;
}
