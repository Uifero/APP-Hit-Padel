# Hit Padel — deploy no Firebase

## 1. Criar o projeto Firebase (grátis)
1. Acesse https://console.firebase.google.com e clique em **Adicionar projeto**.
2. Dê um nome (ex: `hit-padel`) e conclua a criação.
3. No menu lateral, vá em **Compilação > Realtime Database** → **Criar banco de dados** → escolha uma região (ex: `us-central1`) → inicie em **modo de teste**.
4. Vá em **Configurações do projeto** (ícone de engrenagem) → aba **Geral** → role até "Seus apps" → clique no ícone **</>** (Web) → registre um app (ex: `hit-padel-web`) → **não** marque Firebase Hosting nessa tela.
5. Copie o objeto `firebaseConfig` que aparece e cole no arquivo `firebase-config.js` deste projeto, substituindo os campos `COLE_AQUI`.

## 2. Instalar as ferramentas (uma vez só)
No computador, com Node.js instalado:
```
npm install -g firebase-tools
firebase login
```

## 3. Publicar o site
Dentro da pasta `hitpadel-site`:
```
firebase init hosting
```
- Escolha **Use an existing project** → selecione o projeto que você criou.
- Pergunta "What do you want to use as your public directory?" → responda `.` (ponto).
- "Configure as a single-page app?" → **No**.
- "Set up automatic builds with GitHub?" → **No**.
- Se perguntar se quer sobrescrever `index.html`, responda **No** (para manter o seu).

Depois publique:
```
firebase deploy
```
Ao final ele mostra o link público, algo como `https://hit-padel.web.app` — é esse link que você compartilha com o pessoal.

## 4. Colocar domínio próprio (ex: hitpadel.com.br)
No Firebase Console → **Hosting** → **Adicionar domínio personalizado** → siga as instruções para apontar o DNS do seu domínio (registros A/TXT). É grátis e o Firebase cuida do certificado SSL automaticamente.

## 5. Atualizar o app no futuro
Sempre que eu (Claude) mandar arquivos novos, é só substituir na pasta e rodar `firebase deploy` de novo.

## Sobre segurança do PIN de admin
Por enquanto o PIN de admin só bloqueia a *interface* — as regras do banco (`database.rules.json`) estão abertas para leitura/escrita para manter o MVP simples. Isso é suficiente para um torneio entre amigos/clube, mas tecnicamente alguém muito curioso poderia editar os dados direto pelo console do navegador. Se um dia quiser travar isso de verdade, dá para adicionar Firebase Authentication — me avisa quando quiser esse reforço.
