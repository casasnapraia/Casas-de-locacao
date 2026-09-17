importScripts(
 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js'
);

importScripts(
 'https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js'
);


/* =========================================================
   CONFIGURAÇÃO FIREBASE
   ========================================================= */

firebase.initializeApp({

 apiKey:"AIzaSyC8ZtXwPnUa9WnqLdKfYbXzYbXzYbXzYbXzYbXzYbX",

 authDomain:"casas-na-praia.firebaseapp.com",

 projectId:"casas-na-praia",

 storageBucket:"casas-na-praia.appspot.com",

 messagingSenderId:"123456789012",

 appId:"1:123456789012:web:abc123def456"

});


const messaging =
 firebase.messaging();


/* =========================================================
   NOTIFICAÇÃO EM SEGUNDO PLANO
   ========================================================= */

messaging.onBackgroundMessage(
 function(payload){

  console.log(
   '[firebase-messaging-sw.js] Mensagem recebida:',
   payload
  );

  const notificationTitle =
   payload.notification?.title ||
   '🏖️ Casas na Praia';

  const notificationOptions={

   body:
    payload.notification?.body ||
    'Nova solicitação de reserva.',

   tag:
    'casas-na-praia-reserva',

   renotify:true,

   data:{

    url:
     'https://casasnapraia.github.io/Casas-de-locacao/'

   }

  };

  self.registration.showNotification(
   notificationTitle,
   notificationOptions
  );

 }
);


/* =========================================================
   CLIQUE NA NOTIFICAÇÃO
   ========================================================= */

self.addEventListener(
 'notificationclick',
 function(event){

  event.notification.close();

  const url=
   event.notification?.data?.url ||
   'https://casasnapraia.github.io/Casas-de-locacao/';

  event.waitUntil(

   clients.matchAll({
    type:'window',
    includeUncontrolled:true
   }).then(
    function(clientList){

     for(
      const client of clientList
     ){

      if(
       client.url.startsWith(
        'https://casasnapraia.github.io/Casas-de-locacao/'
       ) &&
       'focus' in client
      ){

       return client.focus();

      }

     }

     if(
      clients.openWindow
     ){

      return clients.openWindow(url);

     }

    }
   )

  );

 });
