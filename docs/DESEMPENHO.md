# Desempenho: por que o tema é leve (e como medir)

O Spotify de computador é um navegador (Chromium). Efeitos de vidro bonitos podem ser caros para a
placa de vídeo, e uma extensão que fica "olhando" a tela o tempo todo gasta processador à toa. Esta
é a lista do que foi feito para o tema ficar leve, em ordem de impacto.

## 1. Desfoque do fundo desenhado uma vez, não a cada quadro

O Hazy desenha a capa do álbum em tela cheia e a desfoca **ao vivo** (`filter: blur(...)`). Um filtro
em tela cheia é o item mais caro de todo o tema. Agora a extensão desenha a capa **uma vez por música**
em uma miniatura (176 px de largura) já com os mesmos filtros e entrega ao CSS (`--jc-bgimg`). O CSS
liga `data-jc-bgbaked` e desliga o filtro. Como o fundo é só um degradê suave, a miniatura esticada
fica igual. Se a imagem não carregar, o filtro ao vivo do `user.css` continua valendo.

## 2. Vidro "pronto" no fundo em vez de um `backdrop-filter` em cada painel

`backdrop-filter` (o vidro que desfoca o que está atrás) em áreas grandes é refeito pela placa de
vídeo a cada quadro em que algo muda (rolar, passar o mouse, qualquer animação). O vidro dos painéis
grandes agora vem **embutido no fundo do Hazy** (mais desfoque e saturação), que é uma camada parada.
Os botões da barra de cima e da lateral ficam em cima desse mesmo fundo e não precisam de filtro próprio.
Sobram só os `backdrop-filter` pequenos que realmente passam por cima de conteúdo que rola.

## 3. Um agendador no lugar de ~20 `setInterval` (rodando no tempo ocioso)

Antes cada tarefa da extensão tinha o seu relógio e varria a tela de 0,5 a 1 s, mesmo sem nada mudar.
Agora há um relógio só: ritmo normal enquanto há atividade (rolar, clicar, trocar de página/música,
redimensionar, elementos novos na tela), ritmo lento depois de alguns segundos parado, e nada quando o
app está escondido. As tarefas rodam em `requestIdleCallback`, isto é, só quando o navegador não tem
nada para fazer (o Spotify terminou de montar a tela), nunca disputando com ele. Consultas à página (`querySelectorAll`, `getBoundingClientRect`) são guardadas e só
refeitas quando necessário.

## 4. Cópias pequenas do fundo animado do Spicy

O fundo animado do Spicy Lyrics é copiado em miniatura (160 px) para o cabeçalho do Início e para a
barra do player nas letras, com os filtros aplicados dentro do canvas pequeno, em vez de filtros CSS em
canvas grandes. A cópia é tirada ~5x por segundo e a tela passa de uma cópia para a seguinte
aos poucos (mistura as duas ~30x por segundo, em miniatura), então o movimento fica contínuo. A aura e o equalizador usam resolução reduzida e `setTimeout` (não `requestAnimationFrame`).

## 5. Um relógio só para as animações

Aura, ondas e a mistura do fundo rodam juntas na mesma grade de 40 ms: o navegador monta um quadro por
vez com todas as mudanças, em vez de um quadro para cada animação em momentos diferentes.

## 5b. Menos código

- O CSS deixou de ser copiado para dentro da extensão (−143 KB). A extensão só confere a versão.
- Funções de depuração e código de recursos antigos foram removidos.
- No CSS: declarações repetidas/sobrescritas, regras vazias e seletores de recursos que não existem
  mais saíram, e o prefixo `-webkit-backdrop-filter` (só vale no Safari) foi retirado.

## 6. Medir e mexer na página sem travar o navegador

O teste no app real mostrou que o maior peso eram as tarefas da extensão que **leem** a página
(`getBoundingClientRect`, `getComputedStyle`) e **marcam** elementos (`setAttribute`) alternadamente,
item por item: cada marca invalidava o layout e a leitura seguinte obrigava o navegador a refazê-lo
para a página inteira (centenas de vezes por rodada). Agora cada tarefa lê tudo primeiro e marca no fim,
a estrutura de cada cartão é calculada uma vez e guardada, as tarefas rodam logo depois de um quadro
(quando o layout já está pronto) e uma tarefa que ficar pesada passa sozinha a rodar mais espaçada. As tarefas também passaram a ser
incrementais: cada cartão, texto ou ícone é conferido uma vez e o resultado fica guardado nele; o lado
em que o disco de vinil sai é decidido só quando o mouse entra no cartão. Os laços de animação (aura,
ondas, cópia do fundo) não medem mais a página a cada quadro: visibilidade vem de `IntersectionObserver`,
tamanho de `ResizeObserver`, e o resto é lido logo após um quadro. Variáveis no `<html>` (que refazem o
estilo da página inteira) só são gravadas quando o valor muda, e a cor que segue o clipe muda no máximo
a cada 8 s. Tarefas que só servem quando a página muda (cartões, textos, ícones, alinhamentos) ficam
paradas enquanto nada muda: rodam três vezes depois de cada mudança (elementos novos, imagem carregada,
troca de tela ou de música, janela redimensionada) e descansam. A mudança é contada por região
(área do meio, barra lateral, painel da direita, player, barra de cima): trocar de música mexe só no
player e no painel, então as tarefas da área do meio não rodam à toa.

## 7. Painel da direita e ícones

- Nada de vidro ao vivo por cima do fundo animado do Spicy (cartão de letras, seções do painel) nem nos
  painéis grandes: o Hazy liga alguns e o tema desliga.
- A sombra que o Hazy põe em todos os ícones (`svg { filter: drop-shadow(...) }`) foi desligada.
- Ao trocar de tela, as tarefas da extensão esperam a página nova terminar de montar.

## Como medir

Na janelinha de cores (botão de paleta, ao passar o mouse na foto de perfil) há **Testar desempenho**
(também F9 ou `jcPerf()` no Console). Com uma música tocando, ele leva ~1 min: mede quadros por
segundo e travadas com tudo ligado e desligando, um de cada vez, vidro, filtros, sombras, fundo animado
do Spicy, vídeos, efeitos do tema, o CSS inteiro, só o Hazy e o painel da direita (e mede "Normal" de novo
no fim, para ver se algo mudou durante o teste); depois troca de tela (Músicas Curtidas e volta) e
mede quanto a página demora para assentar. O resultado aparece numa caixa e vai para a área de
transferência.

Na mesma janelinha, **Modo leve** desliga aura, ondas e fundos animados do tema em computadores mais fracos.

> Nota honesta: as medições feitas durante o desenvolvimento foram num navegador simulado (renderização
> por software) com uma maquete do Spotify; servem para comparar versões, não para prever fps reais.
