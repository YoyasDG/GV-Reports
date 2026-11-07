# Reports · Grupo Volcanes

Reportes rápidos de soporte de TI. En lugar de llamar a la extensión, al celular o mandar WhatsApp, cada persona abre el acceso directo **“Reportar a Sistemas”** de su escritorio, escribe una frase o toma una foto, y su reporte queda en la fila. Sistemas le asigna un tiempo estimado y la persona lo sigue desde **Mis reportes**.

## Cómo funciona

**Empleado** (`http://servidor:3000/`)

- La primera vez escribe su nombre y área. La computadora lo recuerda, así que no hay usuario ni contraseña.
- Ve **¿Cuál es tu problema?**, con botones de un clic (Sin internet, Correo, Impresora…), un campo de texto y la opción de agregar una **foto o captura**. Puede pegar con <kbd>Ctrl+V</kbd> o arrastrar la imagen.
- Puede marcar **No puedo trabajar**, que pasa el reporte al frente de la fila.
- Al enviar recibe un folio (`GV-1001`) y su lugar en la fila.
- En **Mis reportes** ve el estado, el tiempo estimado y los mensajes de Sistemas. Si un reporte resuelto vuelve a fallar, puede reabrirlo.

**Administrador** (`http://servidor:3000/admin`)

- La bandeja tiene contadores (abiertos, sin tiempo estimado, vencen hoy, resueltos en la semana), vistas por estado y búsqueda por folio, texto, persona o equipo.
- En cada reporte: fotos, historial, cambio de estado, responsable y **tiempo estimado** en un clic (30 min, 1 h, 2 h, 4 h, 1 día, 3 días o una fecha y hora). Ahí mismo se ve lo que verá el empleado.
- Puedes responder al empleado o dejar notas internas que el empleado no ve.
- Cuando entra un reporte nuevo suena un aviso y, si lo permites, sale una notificación de escritorio. La bandeja se actualiza sola cada 15 s.

## Requisitos

- **Node.js 22.13 o más reciente** (se recomienda la versión LTS actual). No hay que instalar dependencias con `npm install`: usa solo módulos incluidos en Node, entre ellos SQLite (`node:sqlite`).
- Una PC o servidor de la red que esté siempre encendido.

## Instalación en el servidor

```bash
git clone https://github.com/YoyasDG/GV-Reports.git
cd GV-Reports
copy .env.example .env      # en Linux/macOS: cp .env.example .env
# edita .env: ADMIN_USER, ADMIN_PASSWORD, PORT…
npm start
```

Al primer arranque se crea el administrador definido en `.env`. Para agregar más administradores o cambiar contraseñas:

```bash
npm run admin -- crear ana "Ana Torres"
npm run admin -- password ana
npm run admin -- lista
```

### Dejarlo corriendo en Windows

Usa el **Programador de tareas** de Windows. Crea una tarea “Al iniciar el sistema” que ejecute `scripts\iniciar-servidor.cmd` aunque no haya nadie con sesión iniciada. Abre el puerto en el firewall:

```powershell
New-NetFirewallRule -DisplayName "Reports GV" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

## Acceso directo en cada PC

```powershell
powershell -ExecutionPolicy Bypass -File scripts\crear-acceso-directo.ps1 -Servidor "http://192.168.1.10:3000"
```

El script crea **“Reportar a Sistemas”** en el escritorio. Abre Reports en una ventana propia (modo app de Edge o Chrome) y manda el nombre del equipo (`%COMPUTERNAME%`), que aparece en cada reporte. Con `-TodosLosUsuarios`, ejecutado como administrador, lo pone en el escritorio de todos los usuarios. También se puede distribuir por GPO.

## Datos y respaldo

Todo vive en la carpeta `data/`: la base de datos `reports.db`, las fotos en `uploads/` y el secreto de sesión `.secret`. Respáldala con regularidad. Esta carpeta no se sube al repositorio.

## Desarrollo

```bash
npm run dev     # reinicia al guardar cambios
npm test        # prueba de punta a punta de la API
```

Estructura:

```
src/server.js     servidor HTTP y API
src/db.js         esquema SQLite y consultas
src/auth.js       contraseñas (scrypt) y cookies firmadas
public/           páginas del empleado (index.html) y del admin (admin.html)
scripts/          alta de administradores, acceso directo, arranque en Windows
test/             pruebas
```

## Notas de seguridad

- Los empleados se identifican con una cookie firmada que se guarda en su navegador. Es cómodo para una red interna, pero no es una autenticación fuerte. No publiques Reports en internet sin HTTPS ni sin una capa adicional (VPN, proxy con login).
- Las contraseñas de administrador se guardan con scrypt. El inicio de sesión tiene un límite de intentos.
- Solo se aceptan imágenes (JPG, PNG, WEBP, GIF). El navegador las reduce a ≤1600 px antes de subirlas.
