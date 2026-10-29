# Como tudo isso funciona (versão simples)

## 1. O Spotify de computador é uma página da internet

O aplicativo do Spotify no Windows é, por dentro, um **navegador** (Chromium) abrindo uma página web. Tudo o que você vê — botões, listas, capas — é HTML, CSS e JavaScript, como qualquer site.

Esses arquivos ficam empacotados em um arquivo chamado **`xpui.spa`** (na prática, um `.zip` com outro nome), dentro da pasta do Spotify.

Como a aparência de uma página web é definida por **CSS**, mudar o visual do Spotify é, no fundo, escrever CSS. E se um dia o CSS não bastar, dá para rodar **JavaScript** dentro da página para criar botões, ler a música tocando, etc.

## 2. O problema: o Spotify não deixa você mexer nisso

O `xpui.spa` fica dentro da pasta do programa, e o Spotify o restaura a cada atualização. Editar à mão é chato e frágil.

## 3. O Spicetify faz esse trabalho por você

O [Spicetify](https://spicetify.app/) é um programa de linha de comando que:

1. **Faz backup** do `xpui.spa` original (`spicetify backup`).
2. **Abre o pacote** (descompacta).
3. **Injeta** o seu CSS (tema) e o seu JavaScript (extensões) nos arquivos.
4. **Fecha o pacote** de novo e coloca no lugar. É o `spicetify apply`.

Ao abrir o Spotify, ele carrega a "página" já modificada.

| Comando | O que faz |
|---|---|
| `spicetify backup apply` | guarda o original e aplica o tema/extensões |
| `spicetify apply` | reaplica depois que você mudou um arquivo |
| `spicetify watch -s` | reaplica sozinho cada vez que você salva |
| `spicetify restore` | volta ao Spotify original |

## 4. O que o PowerShell é nessa história

O PowerShell é só o **terminal** do Windows: um lugar onde você digita comandos. Ele tem dois papéis aqui:

- **Instalar:** a linha `iwr -useb <endereço> | iex` significa "baixe este script da internet (`iwr`) e execute (`iex`)". O script de instalação do Spicetify e o do Hazy fazem justamente isso: baixam os arquivos, colocam nas pastas certas e ajustam a configuração.
- **Dar ordens ao Spicetify:** `spicetify apply`, `spicetify restore` etc. Ele não faz mágica: só chama o programa `spicetify.exe`, que faz os passos da seção 3.

> Cuidado: `iwr ... | iex` roda o que vier do endereço. Use só endereços de projetos em que você confia (os oficiais do Spicetify e do Hazy, nesse caso).

## 5. As peças deste projeto

```
Hazy (tema base)  ──►  fundo desfocado com a capa, vidro, ajustes básicos
        │
        ▼
theme/user.css    ──►  as MINHAS regras de aparência, aplicadas por cima do Hazy
        │
        ▼
liquid-glass.js   ──►  o que o CSS não consegue fazer (extensão)
```

- **Hazy**: tema pronto. O `user.css` o importa pela internet (`@import url(...)`) e depois sobrescreve o que quiser. Por isso o arquivo é chamado de `user.css`: é o espaço de personalização do usuário.
- **`theme/user.css`**: o visual (vidro, bordas, cores, tamanhos, responsividade).
- **`extensions/liquid-glass.js`**: a "inteligência". Resumindo o que ele faz:
  - descobre as **cores da capa** da música e entrega ao CSS como variáveis;
  - **cria elementos novos** (botão de paleta, minimizar/fechar, cabeçalho de boas-vindas, volume giratório);
  - **desenha efeitos** (a aura sonora usa a análise de áudio do Spotify);
  - **mede a janela** e ajusta o painel "Tocando agora" para a letra nunca ficar escondida;
  - **fala com a janela** do Spotify para minimizar e fechar.
- O CSS e a extensão são **dois arquivos separados**: a extensão só confere a versão do CSS (`--jc-css-v`) e avisa se o `user.css` estiver ausente ou desatualizado. Detalhes de desempenho em `docs/DESEMPENHO.md`.
- **Spicy Lyrics**: outra extensão (de outra pessoa) que busca e mostra as letras. Este projeto só estiliza o cartão dela.

## 6. Como achar o que editar

1. `spicetify enable-devtools` e reinicie o Spotify.
2. Dentro do Spotify, **Ctrl+Shift+I** abre as ferramentas de desenvolvedor, as mesmas do Chrome.
3. Use o seletor de elementos para clicar no que você quer mudar e veja o nome da classe/atributo (por exemplo `data-testid`). O Spotify muda os nomes das classes em atualizações, então prefira atributos estáveis quando existirem.
4. Teste o CSS ali mesmo; quando gostar, copie para `src/user.css`.

## 7. Se algo der errado

- Tela quebrada depois de uma atualização do Spotify: `spicetify backup apply`.
- Quer voltar ao normal: `spicetify restore`.
- Estilo não mudou: confira `spicetify config` (precisa de `inject_css 1`), e reinicie o Spotify.
