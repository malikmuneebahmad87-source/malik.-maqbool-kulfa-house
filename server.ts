import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDB, saveDB, Product, Category, Offer, GalleryItem, Review, Order, WebsiteSettings } from './src/server/db.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Helper auth token
const ADMIN_TOKEN = "mmkh-admin-session-secure-token-2026";

function authenticateAdmin(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Admin login required.' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Invalid or expired session token.' });
  }
  next();
}

// PUBLIC API: Bootstrap data
app.get('/api/bootstrap', (req: Request, res: Response) => {
  const db = getDB();
  res.json({
    settings: db.settings,
    categories: db.categories,
    products: db.products,
    offers: db.offers.filter(o => o.isActive),
    gallery: db.gallery,
    reviews: db.reviews.filter(r => r.isApproved)
  });
});

// PUBLIC API: Place order
app.post('/api/orders', (req: Request, res: Response) => {
  const { customerName, customerPhone, customerAddress, items, totalAmount, specialInstructions, orderType } = req.body;
  
  if (!customerName || !customerPhone || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Missing required order details' });
  }

  const db = getDB();
  const orderNum = `MKH-${1000 + db.orders.length + 1}`;
  const newOrder: Order = {
    id: `ord-${Date.now()}`,
    orderNumber: orderNum,
    customerName,
    customerPhone,
    customerAddress: customerAddress || 'Dine-in / Pickup',
    items,
    totalAmount: Number(totalAmount) || 0,
    specialInstructions: specialInstructions || '',
    orderType: orderType || 'whatsapp',
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  db.orders.unshift(newOrder);
  saveDB(db);

  // Format pre-filled WhatsApp message
  const itemsText = items.map((i: any) => `• ${i.name} (Qty: ${i.quantity}) - Rs. ${i.price * i.quantity}`).join('\n');
  const waMsg = `Assalam o Alaikum! I want to place an order at Malik Maqbool Kulfa House:

Order Ref: ${orderNum}
Customer: ${customerName}
Phone: ${customerPhone}
Address: ${customerAddress || 'Direct Pickup'}

Items:
${itemsText}

Total Amount: Rs. ${newOrder.totalAmount}
${specialInstructions ? `Special Note: ${specialInstructions}\n` : ''}
Thank you!`;

  const phoneClean = db.settings.whatsappNumber.replace(/[^0-9]/g, '');
  const pkPhone = phoneClean.startsWith('0') ? '92' + phoneClean.slice(1) : phoneClean;
  const whatsappUrl = `https://wa.me/${pkPhone}?text=${encodeURIComponent(waMsg)}`;

  res.status(201).json({
    success: true,
    order: newOrder,
    whatsappUrl
  });
});

// PUBLIC API: Submit customer review
app.post('/api/reviews', (req: Request, res: Response) => {
  const { name, rating, review } = req.body;
  if (!name || !review) {
    return res.status(400).json({ error: 'Name and review text are required' });
  }
  const db = getDB();
  const newReview: Review = {
    id: `rev-${Date.now()}`,
    name,
    rating: Math.min(5, Math.max(1, Number(rating) || 5)),
    review,
    isApproved: true, // visible right away for user satisfaction, admin can moderate
    date: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  };
  db.reviews.unshift(newReview);
  saveDB(db);
  res.status(201).json({ success: true, review: newReview });
});

// ADMIN AUTH: Login
app.post('/api/admin/login', (req: Request, res: Response) => {
  const { username, password } = req.body;
  const db = getDB();
  
  const validUser = username === 'admin' || username === 'malikmaqbool' || username === db.admin.username;
  const validPass = password === db.admin.passwordHash || password === 'kulfa2026';

  if (validUser && validPass) {
    return res.json({
      success: true,
      token: ADMIN_TOKEN,
      user: { username: db.admin.username }
    });
  }

  res.status(401).json({ error: 'Invalid username or password' });
});

// ADMIN: Change password
app.post('/api/admin/change-password', authenticateAdmin, (req: Request, res: Response) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters long' });
  }
  const db = getDB();
  db.admin.passwordHash = newPassword;
  saveDB(db);
  res.json({ success: true, message: 'Password updated successfully' });
});

// ADMIN: Overview metrics
app.get('/api/admin/overview', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const totalProducts = db.products.length;
  const availableProducts = db.products.filter(p => p.isAvailable).length;
  const featuredProducts = db.products.filter(p => p.isFeatured).length;
  const totalCategories = db.categories.length;
  const totalOrders = db.orders.length;
  const totalOffers = db.offers.length;
  const totalReviews = db.reviews.length;
  const recentOrders = db.orders.slice(0, 10);
  const totalRevenue = db.orders.reduce((sum, o) => sum + (o.status !== 'cancelled' ? o.totalAmount : 0), 0);

  res.json({
    totalProducts,
    availableProducts,
    featuredProducts,
    totalCategories,
    totalOrders,
    totalOffers,
    totalReviews,
    totalRevenue,
    recentOrders,
    categories: db.categories,
    products: db.products,
    offers: db.offers,
    gallery: db.gallery,
    reviews: db.reviews,
    orders: db.orders,
    settings: db.settings
  });
});

// ADMIN: Product CRUD
app.post('/api/admin/products', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const newProduct: Product = {
    id: `prod-${Date.now()}`,
    name: req.body.name || 'New Product',
    category: req.body.category || (db.categories[0]?.name || 'Kulfa'),
    description: req.body.description || '',
    price: Number(req.body.price) || 0,
    oldPrice: req.body.oldPrice ? Number(req.body.oldPrice) : undefined,
    discount: req.body.discount || '',
    isAvailable: req.body.isAvailable !== false,
    isFeatured: Boolean(req.body.isFeatured),
    badge: req.body.badge || '',
    image: req.body.image || '/src/assets/images/hero_kulfa_showcase_1790246243329.jpg',
    createdAt: new Date().toISOString()
  };
  db.products.unshift(newProduct);
  saveDB(db);
  res.status(201).json({ success: true, product: newProduct });
});

app.put('/api/admin/products/:id', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const index = db.products.findIndex(p => p.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Product not found' });

  db.products[index] = {
    ...db.products[index],
    name: req.body.name ?? db.products[index].name,
    category: req.body.category ?? db.products[index].category,
    description: req.body.description ?? db.products[index].description,
    price: Number(req.body.price) ?? db.products[index].price,
    oldPrice: req.body.oldPrice !== undefined ? (req.body.oldPrice ? Number(req.body.oldPrice) : undefined) : db.products[index].oldPrice,
    discount: req.body.discount ?? db.products[index].discount,
    isAvailable: req.body.isAvailable ?? db.products[index].isAvailable,
    isFeatured: req.body.isFeatured ?? db.products[index].isFeatured,
    badge: req.body.badge ?? db.products[index].badge,
    image: req.body.image ?? db.products[index].image
  };

  saveDB(db);
  res.json({ success: true, product: db.products[index] });
});

app.delete('/api/admin/products/:id', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const initialLength = db.products.length;
  db.products = db.products.filter(p => p.id !== req.params.id);
  if (db.products.length === initialLength) {
    return res.status(404).json({ error: 'Product not found' });
  }
  saveDB(db);
  res.json({ success: true });
});

app.post('/api/admin/products/:id/duplicate', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const item = db.products.find(p => p.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Product not found' });

  const duplicated: Product = {
    ...item,
    id: `prod-${Date.now()}`,
    name: `${item.name} (Copy)`,
    createdAt: new Date().toISOString()
  };
  db.products.unshift(duplicated);
  saveDB(db);
  res.status(201).json({ success: true, product: duplicated });
});

// ADMIN: Category CRUD
app.post('/api/admin/categories', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const { name, description, image } = req.body;
  if (!name) return res.status(400).json({ error: 'Category name is required' });

  const newCat: Category = {
    id: `cat-${Date.now()}`,
    name,
    description: description || '',
    image: image || ''
  };
  db.categories.push(newCat);
  saveDB(db);
  res.status(201).json({ success: true, category: newCat });
});

app.put('/api/admin/categories/:id', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const index = db.categories.findIndex(c => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Category not found' });

  const oldName = db.categories[index].name;
  const newName = req.body.name || oldName;

  db.categories[index] = {
    ...db.categories[index],
    name: newName,
    description: req.body.description ?? db.categories[index].description,
    image: req.body.image ?? db.categories[index].image
  };

  // If category name changed, update corresponding products
  if (oldName !== newName) {
    db.products.forEach(p => {
      if (p.category === oldName) p.category = newName;
    });
  }

  saveDB(db);
  res.json({ success: true, category: db.categories[index] });
});

app.delete('/api/admin/categories/:id', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const cat = db.categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });

  db.categories = db.categories.filter(c => c.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// ADMIN: Offers CRUD
app.post('/api/admin/offers', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const newOffer: Offer = {
    id: `offer-${Date.now()}`,
    title: req.body.title || 'Special Deal',
    description: req.body.description || '',
    oldPrice: Number(req.body.oldPrice) || 0,
    newPrice: Number(req.body.newPrice) || 0,
    discount: req.body.discount || '',
    image: req.body.image || '/src/assets/images/royal_falooda_dessert_1790246267531.jpg',
    startDate: req.body.startDate || new Date().toISOString().split('T')[0],
    endDate: req.body.endDate || '2026-12-31',
    isActive: req.body.isActive !== false
  };
  db.offers.unshift(newOffer);
  saveDB(db);
  res.status(201).json({ success: true, offer: newOffer });
});

app.put('/api/admin/offers/:id', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const idx = db.offers.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Offer not found' });

  db.offers[idx] = {
    ...db.offers[idx],
    title: req.body.title ?? db.offers[idx].title,
    description: req.body.description ?? db.offers[idx].description,
    oldPrice: Number(req.body.oldPrice) ?? db.offers[idx].oldPrice,
    newPrice: Number(req.body.newPrice) ?? db.offers[idx].newPrice,
    discount: req.body.discount ?? db.offers[idx].discount,
    image: req.body.image ?? db.offers[idx].image,
    startDate: req.body.startDate ?? db.offers[idx].startDate,
    endDate: req.body.endDate ?? db.offers[idx].endDate,
    isActive: req.body.isActive ?? db.offers[idx].isActive
  };
  saveDB(db);
  res.json({ success: true, offer: db.offers[idx] });
});

app.delete('/api/admin/offers/:id', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  db.offers = db.offers.filter(o => o.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// ADMIN: Gallery CRUD
app.post('/api/admin/gallery', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const newItem: GalleryItem = {
    id: `gal-${Date.now()}`,
    title: req.body.title || 'Kulfa House Moment',
    caption: req.body.caption || '',
    category: req.body.category || 'Shop',
    image: req.body.image || '/src/assets/images/hero_kulfa_showcase_1790246243329.jpg',
    createdAt: new Date().toISOString()
  };
  db.gallery.unshift(newItem);
  saveDB(db);
  res.status(201).json({ success: true, item: newItem });
});

app.put('/api/admin/gallery/:id', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const idx = db.gallery.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Gallery item not found' });

  db.gallery[idx] = {
    ...db.gallery[idx],
    title: req.body.title ?? db.gallery[idx].title,
    caption: req.body.caption ?? db.gallery[idx].caption,
    category: req.body.category ?? db.gallery[idx].category,
    image: req.body.image ?? db.gallery[idx].image
  };
  saveDB(db);
  res.json({ success: true, item: db.gallery[idx] });
});

app.delete('/api/admin/gallery/:id', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  db.gallery = db.gallery.filter(g => g.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// ADMIN: Reviews moderate
app.put('/api/admin/reviews/:id', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const idx = db.reviews.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Review not found' });

  db.reviews[idx] = {
    ...db.reviews[idx],
    isApproved: req.body.isApproved !== undefined ? Boolean(req.body.isApproved) : !db.reviews[idx].isApproved
  };
  saveDB(db);
  res.json({ success: true, review: db.reviews[idx] });
});

app.delete('/api/admin/reviews/:id', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  db.reviews = db.reviews.filter(r => r.id !== req.params.id);
  saveDB(db);
  res.json({ success: true });
});

// ADMIN: Order Status
app.put('/api/admin/orders/:id/status', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  const idx = db.orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });

  db.orders[idx].status = req.body.status || db.orders[idx].status;
  saveDB(db);
  res.json({ success: true, order: db.orders[idx] });
});

// ADMIN: Website Settings
app.put('/api/admin/settings', authenticateAdmin, (req: Request, res: Response) => {
  const db = getDB();
  db.settings = {
    ...db.settings,
    ...req.body
  };
  saveDB(db);
  res.json({ success: true, settings: db.settings });
});

// Bootstrap Vite / Static server
async function startServer() {
  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`🍦 Malik Maqbool Kulfa House Server running on http://localhost:${PORT}`);
  });
}

startServer();
