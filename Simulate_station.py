import requests
import time
import random
import math
from datetime import datetime

# --- CONFIGURATION ---
# Remplacez ceci par votre Channel ID et votre Clé d'écriture (Write API Key)
# Vous les trouverez sur ThingSpeak après avoir créé le canal (voir partie 2)
CHANNEL_ID = "VOTRE_CHANNEL_ID"
WRITE_API_KEY = "VOTRE_WRITE_API_KEY"

# URL de l'API ThingSpeak
THINGSPEAK_URL = "https://api.thingspeak.com/update"

# Configuration des valeurs de base (pour Gif-sur-Yvette par exemple)
BASE_VALUES = {
    "temperature": 22.0,   # °C
    "humidity": 45.0,      # %
    "pressure": 1013.0,    # hPa
    "light": 800           # lux
}

def generate_simulated_data():
    """
    Génère des valeurs avec un cycle journalier de température et de luminosité,
    ainsi que de légères variations aléatoires.
    """
    data = {}

    current_time = datetime.now()
    hour = current_time.hour + current_time.minute / 60 + current_time.second / 3600

    # Température moyenne à 22°C, minimum vers 3h et maximum vers 15h.
    temperature = BASE_VALUES["temperature"] + 5 * math.cos(
        2 * math.pi * (hour - 15) / 24
    )
    data["field1"] = round(temperature + random.uniform(-0.2, 0.2), 1)
    
    # Humidité : variation +/- 2%
    BASE_VALUES["humidity"] += random.uniform(-1.0, 1.0)
    # Contrainte entre 0 et 100%
    BASE_VALUES["humidity"] = max(0, min(100, BASE_VALUES["humidity"]))
    data["field2"] = round(BASE_VALUES["humidity"], 1)
    
    # Pression : variation lente +/- 2 hPa
    BASE_VALUES["pressure"] += random.uniform(-0.5, 0.5)
    data["field3"] = round(BASE_VALUES["pressure"], 1)
    
    # Luminosité nulle la nuit, avec un maximum vers midi.
    daylight = max(0, math.sin(math.pi * (hour - 6) / 12))
    light = BASE_VALUES["light"] * daylight
    light += random.uniform(-50, 50) * daylight
    data["field4"] = round(max(0, light), 0)
    
    return data

def send_to_thingspeak(data):
    """
    Envoie les données à ThingSpeak.
    """
    params = {
        "api_key": "JNMPWFSB1CVX2ZSH",
        "field1": data["field1"],
        "field2": data["field2"],
        "field3": data["field3"],
        "field4": data["field4"]
    }
    
    try:
        response = requests.post(THINGSPEAK_URL, params=params, timeout=10)
        if response.status_code == 200:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Données envoyées avec succès : {data}")
            return True
        else:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Erreur HTTP {response.status_code}: {response.text}")
            return False
    except Exception as e:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Exception lors de l'envoi : {e}")
        return False

def main():
    print(f"Démarrage de la simulation pour le Canal {3564665}...")
    print("Arrêt avec Ctrl+C.")
    
    while True:
        data = generate_simulated_data()
        send_to_thingspeak(data)
        
        # ThingSpeak impose un minimum de 15 secondes entre les envois en version gratuite.
        # Ici, on attend 15 minutes (900 secondes) pour correspondre à la config de votre app.js.
        # Pour tester rapidement, changez 900 en 15 ou 30.
        print("Attente de 15 minutes avant la prochaine mesure...")
        time.sleep(15*60) 

if __name__ == "__main__":
    main()