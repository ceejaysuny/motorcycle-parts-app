// Global variables
let currentUser = null;
let authToken = localStorage.getItem('authToken');
let currentSection = 'dashboard';

// API Base URL
const API_BASE = '/api';

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    initializeApp();
    setupEventListeners();
    loadDashboardData();
});

// Initialize application
function initializeApp() {
    // Check authentication
    if (authToken) {
        // Validate token and load user data
        validateToken();
    } else {
        // Show login form or redirect to login
        showLoginForm();
    }

    // Setup navigation
    setupNavigation();
    
    // Load initial data
    loadNotifications();
}

// Setup event listeners
function setupEventListeners() {
    // Navigation toggle for mobile
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navMenu');
    
    if (navToggle) {
        navToggle.addEventListener('click', () => {
            navMenu.classList.toggle('active');
        });
    }

    // Search functionality
    const productSearch = document.getElementById('productSearch');
    if (productSearch) {
        productSearch.addEventListener('input', debounce(searchProducts, 300));
    }

    // Form submissions
    const productForm = document.getElementById('productForm');
    if (productForm) {
        productForm.addEventListener('submit', handleProductSubmit);
    }
}

// Setup navigation
function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const section = link.getAttribute('data-section');
            showSection(section);
            
            // Update active nav link
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
        });
    });
}

// Show specific section
function showSection(sectionName) {
    // Hide all sections
    const sections = document.querySelectorAll('.content-section');
    sections.forEach(section => section.classList.remove('active'));
    
    // Show target section
    const targetSection = document.getElementById(sectionName);
    if (targetSection) {
        targetSection.classList.add('active');
        currentSection = sectionName;
        
        // Load section-specific data
        loadSectionData(sectionName);
    }
}

// Load section-specific data
function loadSectionData(section) {
    switch (section) {
        case 'dashboard':
            loadDashboardData();
            break;
        case 'products':
            loadProducts();
            break;
        case 'inventory':
            loadInventory();
            break;
        case 'suppliers':
            loadSuppliers();
            break;
        case 'customers':
            loadCustomers();
            break;
        case 'orders':
            loadOrders();
            break;
        case 'reports':
            loadReports();
            break;
    }
}

// API Helper Functions
async function apiRequest(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const config = {
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        },
        ...options
    };

    if (authToken) {
        config.headers['Authorization'] = `Bearer ${authToken}`;
    }

    try {
        showLoading();
        const response = await fetch(url, config);
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Request failed');
        }
        
        return data;
    } catch (error) {
        console.error('API Request failed:', error);
        showToast(error.message, 'error');
        throw error;
    } finally {
        hideLoading();
    }
}

// Authentication
async function validateToken() {
    try {
        const user = await apiRequest('/users/me');
        currentUser = user;
        document.getElementById('userName').textContent = user.username;
    } catch (error) {
        // Token invalid, clear and show login
        localStorage.removeItem('authToken');
        authToken = null;
        showLoginForm();
    }
}

function showLoginForm() {
    // For demo purposes, we'll simulate a login
    // In a real app, this would show a proper login form
    const username = prompt('Username (demo):') || 'admin';
    const password = prompt('Password (demo):') || 'password';
    
    login(username, password);
}

async function login(username, password) {
    try {
        const response = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            authToken = data.token;
            localStorage.setItem('authToken', authToken);
            currentUser = data.user;
            document.getElementById('userName').textContent = data.user.username;
            showToast('Login successful', 'success');
        } else {
            showToast(data.error || 'Login failed', 'error');
        }
    } catch (error) {
        showToast('Login failed', 'error');
    }
}

function logout() {
    localStorage.removeItem('authToken');
    authToken = null;
    currentUser = null;
    location.reload();
}

// Dashboard Functions
async function loadDashboardData() {
    try {
        // Load KPI data
        const stats = await apiRequest('/stats');
        updateKPIs(stats);
        
        // Load recent orders
        const orders = await apiRequest('/sales-orders?limit=5');
        updateRecentOrders(orders.sales_orders);
        
        // Load low stock alerts
        const lowStock = await apiRequest('/inventory/alerts/low-stock');
        updateLowStockAlerts(lowStock);
        
        // Load sales chart
        loadSalesChart();
        
        // Load top products
        loadTopProducts();
        
    } catch (error) {
        console.error('Failed to load dashboard data:', error);
    }
}

function updateKPIs(stats) {
    // Update with mock data for demo
    document.getElementById('totalSales').textContent = '$125,430';
    document.getElementById('totalOrders').textContent = '1,247';
    document.getElementById('totalProducts').textContent = stats?.statistics?.total_products || '0';
    document.getElementById('lowStockItems').textContent = '12';
}

function updateRecentOrders(orders) {
    const tbody = document.querySelector('#recentOrdersTable tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    // Mock data for demo
    const mockOrders = [
        { id: 'SO-001', customer: 'ABC Motors', amount: '$1,250', status: 'completed', date: '2024-01-15' },
        { id: 'SO-002', customer: 'XYZ Parts', amount: '$890', status: 'processing', date: '2024-01-14' },
        { id: 'SO-003', customer: 'Quick Fix', amount: '$2,100', status: 'shipped', date: '2024-01-13' },
        { id: 'SO-004', customer: 'Moto World', amount: '$750', status: 'pending', date: '2024-01-12' },
        { id: 'SO-005', customer: 'Speed Shop', amount: '$1,800', status: 'completed', date: '2024-01-11' }
    ];
    
    mockOrders.forEach(order => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${order.id}</td>
            <td>${order.customer}</td>
            <td>${order.amount}</td>
            <td><span class="status-badge status-${order.status}">${order.status}</span></td>
            <td>${order.date}</td>
        `;
        tbody.appendChild(row);
    });
}

function updateLowStockAlerts(alerts) {
    const container = document.getElementById('lowStockAlerts');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Mock data for demo
    const mockAlerts = [
        { product: 'Brake Pads - Honda CBR', sku: 'BP-CBR-001', stock: 3, threshold: 10 },
        { product: 'Oil Filter - Yamaha R1', sku: 'OF-R1-002', stock: 1, threshold: 5 },
        { product: 'Chain - Kawasaki Ninja', sku: 'CH-NIN-003', stock: 2, threshold: 8 }
    ];
    
    mockAlerts.forEach(alert => {
        const alertItem = document.createElement('div');
        alertItem.className = 'alert-item';
        alertItem.innerHTML = `
            <i class="fas fa-exclamation-triangle"></i>
            <div class="alert-content">
                <h4>${alert.product}</h4>
                <p>Stock: ${alert.stock} (Threshold: ${alert.threshold})</p>
            </div>
        `;
        container.appendChild(alertItem);
    });
}

function loadSalesChart() {
    const ctx = document.getElementById('salesChart');
    if (!ctx) return;
    
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
            datasets: [{
                label: 'Sales',
                data: [12000, 19000, 15000, 25000, 22000, 30000],
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) {
                            return '$' + value.toLocaleString();
                        }
                    }
                }
            }
        }
    });
}

function loadTopProducts() {
    const container = document.getElementById('topProductsList');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Mock data for demo
    const mockProducts = [
        { name: 'Brake Pads Set', sku: 'BP-001', sales: '$5,200', quantity: '45 units' },
        { name: 'Engine Oil 10W-40', sku: 'EO-002', sales: '$3,800', quantity: '120 units' },
        { name: 'Air Filter', sku: 'AF-003', sales: '$2,900', quantity: '78 units' },
        { name: 'Spark Plugs', sku: 'SP-004', sales: '$2,100', quantity: '156 units' }
    ];
    
    mockProducts.forEach(product => {
        const productItem = document.createElement('div');
        productItem.className = 'product-item';
        productItem.innerHTML = `
            <div class="product-info">
                <h4>${product.name}</h4>
                <p>${product.sku}</p>
            </div>
            <div class="product-sales">
                <div class="amount">${product.sales}</div>
                <div class="quantity">${product.quantity}</div>
            </div>
        `;
        container.appendChild(productItem);
    });
}

// Product Functions
async function loadProducts() {
    try {
        const products = await apiRequest('/products');
        updateProductsTable(products.products || []);
    } catch (error) {
        console.error('Failed to load products:', error);
        // Show mock data for demo
        updateProductsTable([]);
    }
}

function updateProductsTable(products) {
    const tbody = document.querySelector('#productsTable tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    // Mock data for demo
    const mockProducts = [
        { sku: 'BP-001', name: 'Brake Pads Set', brand: 'Honda', stock: 25, price: '$89.99', status: 'active' },
        { sku: 'EO-002', name: 'Engine Oil 10W-40', brand: 'Yamaha', stock: 150, price: '$24.99', status: 'active' },
        { sku: 'AF-003', name: 'Air Filter', brand: 'Kawasaki', stock: 8, price: '$34.99', status: 'low_stock' },
        { sku: 'SP-004', name: 'Spark Plugs', brand: 'Honda', stock: 0, price: '$12.99', status: 'out_of_stock' },
        { sku: 'CH-005', name: 'Drive Chain', brand: 'Suzuki', stock: 45, price: '$129.99', status: 'active' }
    ];
    
    mockProducts.forEach(product => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${product.sku}</td>
            <td>${product.name}</td>
            <td>${product.brand}</td>
            <td>${product.stock}</td>
            <td>${product.price}</td>
            <td><span class="status-badge status-${product.status}">${product.status.replace('_', ' ')}</span></td>
            <td>
                <button class="btn btn-secondary" onclick="editProduct('${product.sku}')">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-danger" onclick="deleteProduct('${product.sku}')">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

async function searchProducts() {
    const searchTerm = document.getElementById('productSearch').value;
    try {
        const products = await apiRequest(`/products?search=${encodeURIComponent(searchTerm)}`);
        updateProductsTable(products.products || []);
    } catch (error) {
        console.error('Search failed:', error);
    }
}

// Inventory Functions
async function loadInventory() {
    try {
        const inventory = await apiRequest('/inventory');
        updateInventoryTable(inventory.inventory || []);
        updateInventoryOverview();
    } catch (error) {
        console.error('Failed to load inventory:', error);
        updateInventoryOverview();
    }
}

function updateInventoryOverview() {
    // Mock data for demo
    document.getElementById('totalInventoryValue').textContent = '$245,680';
    document.getElementById('lowStockCount').textContent = '12';
    document.getElementById('outOfStockCount').textContent = '3';
    document.getElementById('reorderSuggestions').textContent = '8';
}

function updateInventoryTable(inventory) {
    const tbody = document.querySelector('#inventoryTable tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    // Mock data for demo
    const mockInventory = [
        { product: 'Brake Pads Set', sku: 'BP-001', warehouse: 'Main Warehouse', stock: 25, threshold: 10, status: 'good', lastUpdated: '2024-01-15' },
        { product: 'Engine Oil 10W-40', sku: 'EO-002', warehouse: 'Main Warehouse', stock: 150, threshold: 50, status: 'good', lastUpdated: '2024-01-14' },
        { product: 'Air Filter', sku: 'AF-003', warehouse: 'Secondary Warehouse', stock: 8, threshold: 15, status: 'low', lastUpdated: '2024-01-13' },
        { product: 'Spark Plugs', sku: 'SP-004', warehouse: 'Main Warehouse', stock: 0, threshold: 20, status: 'out', lastUpdated: '2024-01-12' }
    ];
    
    mockInventory.forEach(item => {
        const row = document.createElement('tr');
        const statusClass = item.status === 'good' ? 'status-active' : item.status === 'low' ? 'status-pending' : 'status-inactive';
        
        row.innerHTML = `
            <td>${item.product}</td>
            <td>${item.sku}</td>
            <td>${item.warehouse}</td>
            <td>${item.stock}</td>
            <td>${item.threshold}</td>
            <td><span class="status-badge ${statusClass}">${item.status}</span></td>
            <td>${item.lastUpdated}</td>
            <td>
                <button class="btn btn-secondary" onclick="adjustStock('${item.sku}')">
                    <i class="fas fa-edit"></i>
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// Modal Functions
function openProductModal() {
    document.getElementById('productModal').style.display = 'block';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

function openSupplierModal() {
    showToast('Supplier management coming soon!', 'info');
}

function openCustomerModal() {
    showToast('Customer management coming soon!', 'info');
}

function openOrderModal() {
    showToast('Order management coming soon!', 'info');
}

function openStockAdjustmentModal() {
    showToast('Stock adjustment coming soon!', 'info');
}

// Form Handlers
async function handleProductSubmit(e) {
    e.preventDefault();
    
    const formData = {
        sku: document.getElementById('productSku').value,
        name: document.getElementById('productName').value,
        description: document.getElementById('productDescription').value,
        brand: document.getElementById('productBrand').value,
        model_compatibility: document.getElementById('productModel').value
    };
    
    try {
        await apiRequest('/products', {
            method: 'POST',
            body: JSON.stringify(formData)
        });
        
        showToast('Product created successfully!', 'success');
        closeModal('productModal');
        loadProducts();
        
        // Reset form
        document.getElementById('productForm').reset();
    } catch (error) {
        showToast('Failed to create product', 'error');
    }
}

// Utility Functions
function showLoading() {
    document.getElementById('loadingOverlay').style.display = 'flex';
}

function hideLoading() {
    document.getElementById('loadingOverlay').style.display = 'none';
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem;">
            <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
            <span>${message}</span>
        </div>
    `;
    
    document.getElementById('toastContainer').appendChild(toast);
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        toast.remove();
    }, 5000);
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Placeholder functions for demo
function loadSuppliers() {
    console.log('Loading suppliers...');
}

function loadCustomers() {
    console.log('Loading customers...');
}

function loadOrders() {
    console.log('Loading orders...');
}

function loadReports() {
    console.log('Loading reports...');
}

async function loadNotifications() {
    try {
        const notifications = await apiRequest('/notifications');
        const unreadCount = notifications.notifications?.filter(n => !n.is_read).length || 0;
        document.getElementById('notificationBadge').textContent = unreadCount;
    } catch (error) {
        console.error('Failed to load notifications:', error);
        document.getElementById('notificationBadge').textContent = '0';
    }
}

function editProduct(sku) {
    showToast(`Edit product ${sku} - Coming soon!`, 'info');
}

function deleteProduct(sku) {
    if (confirm(`Are you sure you want to delete product ${sku}?`)) {
        showToast(`Delete product ${sku} - Coming soon!`, 'info');
    }
}

function adjustStock(sku) {
    showToast(`Adjust stock for ${sku} - Coming soon!`, 'info');
}

function checkLowStock() {
    showToast('Checking low stock items...', 'info');
}

function exportProducts() {
    showToast('Export functionality coming soon!', 'info');
}

function generateReport() {
    showToast('Report generation coming soon!', 'info');
}

// Close modals when clicking outside
window.onclick = function(event) {
    const modals = document.querySelectorAll('.modal');
    modals.forEach(modal => {
        if (event.target === modal) {
            modal.style.display = 'none';
        }
    });
}

