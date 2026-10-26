#!/bin/bash
tails=(N415MC N675BA N890JS N868JA N98769 N705QS N7729A N674FR)
hits=0
total=0

echo "=== Testing ${#tails[@]} airborne aircraft against live server ==="
echo ""

for tail in "${tails[@]}"; do
  for round in 1 2; do
    total=$((total + 1))
    echo -n "[$total] $tail (round $round): "
    
    response=$(curl -s "https://contrail-xnd3.onrender.com/api/ac/$tail")
    feedOk=$(echo "$response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('feedOk', 'null'))" 2>/dev/null)
    hasAc=$(echo "$response" | python3 -c "import json,sys; print('yes' if json.load(sys.stdin).get('ac') else 'no')" 2>/dev/null)
    
    if [ "$hasAc" = "yes" ]; then
      hits=$((hits + 1))
      echo "✓ HIT (feedOk=$feedOk)"
    else
      echo "✗ MISS (feedOk=$feedOk)"
    fi
    
    sleep 1
  done
done

echo ""
echo "=== Results ==="
echo "Hits: $hits / $total"
echo "Success rate: $(python3 -c "print(f'{$hits/$total*100:.1f}%')")"
