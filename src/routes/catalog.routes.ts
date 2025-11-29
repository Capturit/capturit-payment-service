import { Router, Request, Response } from 'express';
import { CatalogService } from '../services/catalog.service';
import type { CatalogResponse, CategoryResponse } from '../types/catalog.types';

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

  return router;
}
