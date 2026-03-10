// Versión corregida del admin panel
console.log(`
███████╗ ██████╗ ██╗   ██╗███████╗███████╗
██╔════╝██╔═══██╗██║   ██║██╔════╝██╔════╝
█████╗  ██║   ██║██║   ██║█████╗  ███████╗
██╔══╝  ██║   ██║╚██╗ ██╔╝██╔══╝  ╚════██║
██║     ╚██████╔╝ ╚████╔╝ ███████╗███████║
╚═╝      ╚═════╝   ╚═══╝  ╚══════╝╚══════╝
Admin Panel v1.0 - ${new Date().toLocaleDateString('es-AR')}
===========================================
Sistema de Gestión de ProgressBar
Tiendanube/Nuvemshop - Render Deploy
`);

// Configuración inicial de Nexus (corregido)
try {
  window.NexusAPI = window.NexusAPI || {};
  
  // Inicialización segura de Nexus
  window.NexusAPI.init(
    {
      appId: process.env.TIENDANUBE_CLIENT_ID,
      scope: ['read_products', 'write_scripts']
    },
    function(err) {
      if (err) {
        console.error('[Nexus] Init Error:', err);
        // Mostrar mensaje de error en UI
        showErrorModal('Error de autenticación de Nexus');
      } else {
        console.log('[Nexus] Autenticación exitosa');
      }
    }
  );
} catch (error) {
  console.error('[Nexus] Error al inicializar:', error);
  showErrorModal('Error al inicializar Nexus');
}

// Función de error para UI
function showErrorModal(message) {
  // Implementación de muestra - deberías reemplazar con tu UI específica
  console.warn('Modal de error (reemplazar con UI real):', message);
}

// Agregar version info al window para acceso global
window.AppVersion = {
  name: 'ProgressBar Admin',
  version: 'v1.0.3',
  buildDate: new Date().toISOString()
};

console.log('[App] Versión cargada:', window.AppVersion);