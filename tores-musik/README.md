# Tores Musiklektion

Sjung en låt, så gör **GPT 6 Astra** ett helt band av den: trummor, bas, ackord och en motmelodi som följer dina toner. Eleverna kan starta egna grupper, gå med i vilken grupp som helst och dela låtar med varandra.

## Starta

Kräver Node 18 eller nyare. Inga paket behöver installeras.

```bash
cd tores-musik
cp .env.example .env      # skriv in OPENAI_API_KEY i .env
npm start                 # http://localhost:3000
```

`.env` finns i `.gitignore`, så nyckeln hamnar aldrig på GitHub, och den stannar på servern så eleverna inte kan kopiera den från webbläsaren.

## Vad appen gör

| Flik | Vad du gör |
|------|------------|
| 🎤 **Sjung** | Spela in (eller ladda upp en inspelning). Appen hittar dina toner, `gpt-4o-transcribe` skriver ner texten, och GPT 6 Astra arrangerar ett band i tonarten du sjöng i, lika långt som din sång. Du kan också skapa en låt från bara en idé. |
| 🎛️ **Studio** | Producera för hand: ackord per takt, trummaskin, bas- och ackordrytm, en pianorulle för melodin, ljudval och mixer. Eller skriv en ändring till Astra ("tyngre trummor", "byt till moll"); ett klick är en förfrågan, ingen agent som gör saker själv. Exportera som WAV, med eller utan sång. |
| 👥 **Grupper** | Starta en grupp, gå med i andras, och spara låtar (med sång) så hela gruppen kan öppna dem. |

Appen har inga egna gränser för hur mycket man får använda Astra. De gränser som finns är de som OpenAI-kontot har.

## Spela in från elevernas egna enheter

Webbläsare släpper bara fram mikrofonen på `https` eller `localhost`. Om eleverna ansluter till Tores dator över skolans nätverk (t.ex. `http://192.168.1.20:3000`) kan de ladda upp inspelningar men inte spela in direkt. För att slå på https:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=tores-musik" -keyout key.pem -out cert.pem
```

Lägg sedan till `CERT_FILE=cert.pem` och `KEY_FILE=key.pem` i `.env`. Webbläsaren varnar en gång för certifikatet; godkänn varningen.

Kör inte servern öppet på internet: alla som når den kan använda API-nyckeln.

## Inställningar (`.env`)

| Variabel | Standard | |
|----------|----------|---|
| `OPENAI_API_KEY` | | krävs |
| `ASTRA_MODEL` | `gpt-6-astra` | modellen som arrangerar |
| `ASTRA_EFFORT` | `low` | `low` är snabbast (cirka 20 s per låt) |
| `TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | skriver ner sångtexten |
| `PORT` | `3000` | |

Grupper, låtar och inspelningar sparas i `data/` (finns också i `.gitignore`).

## Hur det funkar

GPT 6 Astra svarar med text, inte ljud, så den skriver arrangemanget som strukturerad JSON (tempo, tonart, ackord per takt, 16-stegsmönster och melodinoter). `public/engine.js` spelar sedan upp det med Web Audio-syntar och mixar in din sånginspelning. Samma låt-JSON är det du redigerar för hand i studion, så Astra och du jobbar på samma sak.
